import { BadRequestException, Injectable, Logger, NotFoundException } from "@nestjs/common";
import { OnEvent } from "@nestjs/event-emitter";
import { PrismaService } from "../../infrastructure/database/prisma.service";

// Stamp cards.
//
// Six orders, a free thing. The model every takeaway already runs on paper,
// which is why it needs no explaining to a customer and no training for staff.
//
// ── Where a stamp comes from ────────────────────────────────────────────────
//
// A COMPLETED order, from a signed-in customer, at a location with an active
// card, meeting the minimum spend.
//
// Completed rather than accepted, because an order that is cancelled or
// refunded afterwards should never have earned anything, and taking a stamp
// back that somebody has already seen is a worse experience than a stamp that
// arrives a few hours late.
//
// The reason that works here and would not in most systems: the 5am rollover
// completes anything still in flight. A shop that never presses the button
// still pays out, by the following morning at the latest — and that cron
// calls this directly, because it completes orders with raw SQL and emits no
// event on purpose (see OrdersAutoCompleteCron for why).
//
// A refund after completion still takes the stamp back. That is the one case
// the ladder cannot rule out.
//
// ── Why the order id is unique ──────────────────────────────────────────────
//
// It is the whole defence against double-minting. A webhook replay, a retry,
// an operator re-opening and re-completing an order — all of them try to
// insert the same orderId and lose to the constraint. Counting stamps and
// checking "have I done this one?" in application code would race.
//
// ── What is frozen ──────────────────────────────────────────────────────────
//
// The reward's label and item are copied onto the reward when it is earned.
// An operator changing next month's offer must not silently rewrite what a
// customer was already promised.

const DEFAULT_STAMPS = 6;

/** Only a finished order earns. The 5am rollover is what makes this reachable
 *  for shops that never press the button. */
const EARNING = new Set(["COMPLETED"]);

/** The order is not happening. Whatever it earned comes back. */
const REVOKING = new Set(["CANCELLED", "REJECTED", "FAILED", "REFUNDED"]);

@Injectable()
export class LoyaltyService {
  private readonly logger = new Logger(LoyaltyService.name);

  constructor(private readonly prisma: PrismaService) {}

  // ── Operator side ────────────────────────────────────────────────────────

  /** The card for a location, or a sensible unsaved default to edit. */
  async getCard(tenantId: string, locationId: string) {
    await this.assertLocation(tenantId, locationId);
    const card = await this.prisma.loyaltyCard.findUnique({
      where: { locationId },
      include: { rewardItem: { select: { id: true, name: true } } },
    });
    if (card) return card;
    // Not created on read — an operator opening the tab should not bring a
    // card into being, and isActive false means it gives nothing away anyway.
    return {
      locationId,
      isActive: false,
      stampsRequired: DEFAULT_STAMPS,
      minimumSpend: null,
      rewardItemId: null,
      rewardLabel: "Free item",
      rewardExpiryDays: null,
      rewardItem: null,
    };
  }

  async upsertCard(
    tenantId: string,
    locationId: string,
    dto: {
      isActive?: boolean;
      stampsRequired?: number;
      minimumSpend?: number | null;
      rewardItemId?: string | null;
      rewardLabel?: string;
      rewardExpiryDays?: number | null;
    },
  ) {
    await this.assertLocation(tenantId, locationId);

    const stampsRequired = Math.min(
      20,
      Math.max(2, Math.round(dto.stampsRequired ?? DEFAULT_STAMPS)),
    );
    // A one-stamp card is a discount, not a loyalty scheme, and twenty is
    // already past the point anyone finishes one.

    if (dto.rewardItemId) {
      const item = await this.prisma.menuItem.findFirst({
        // MenuItem carries no tenantId of its own — it hangs off the brand.
        where: { id: dto.rewardItemId, brandId: { in: await this.brandIds(tenantId) } },
        select: { id: true },
      });
      if (!item) throw new BadRequestException("Reward item not found");
    }

    // Turning it ON without saying what the reward is would put an empty
    // promise on every customer's card.
    const label = (dto.rewardLabel ?? "").trim();
    if (dto.isActive && !label && !dto.rewardItemId) {
      throw new BadRequestException(
        "Choose a reward, or describe it, before switching the card on.",
      );
    }

    const data = {
      isActive: dto.isActive ?? false,
      stampsRequired,
      minimumSpend:
        dto.minimumSpend === null || dto.minimumSpend === undefined
          ? null
          : Math.max(0, Number(dto.minimumSpend)),
      rewardItemId: dto.rewardItemId ?? null,
      rewardLabel: label || "Free item",
      rewardExpiryDays:
        dto.rewardExpiryDays === null || dto.rewardExpiryDays === undefined
          ? null
          : Math.max(1, Math.round(dto.rewardExpiryDays)),
    };

    return this.prisma.loyaltyCard.upsert({
      where: { locationId },
      create: { tenantId, locationId, ...data },
      update: data,
      include: { rewardItem: { select: { id: true, name: true } } },
    });
  }

  // ── Earning ──────────────────────────────────────────────────────────────

  /**
   * A completed order may have earned a stamp.
   *
   * Never throws into the caller. This rides on the order status transition,
   * and a loyalty scheme failing must not roll back a kitchen state that staff
   * can see, to protect a stamp nobody has looked at yet.
   */
  @OnEvent("order.status_changed")
  async onOrderStatusChanged(payload: {
    orderId?: string;
    toStatus?: string;
  }): Promise<void> {
    // `toStatus`, which is what OrdersService.updateStatus emits. This read
    // `newStatus` and matched nothing, so no stamp was ever awarded — the
    // guard returned on the first line of every transition.
    if (!payload.orderId) return;
    try {
      // Taken back as readily as it is given. An order that is cancelled or
      // rejected after acceptance must not leave a stamp behind, or six
      // cancellations are a free main.
      if (REVOKING.has(payload.toStatus ?? "")) {
        await this.revokeForOrder(payload.orderId);
        return;
      }
      if (payload.toStatus !== "COMPLETED") return;
      await this.awardForOrder(payload.orderId);
    } catch (err) {
      this.logger.warn(
        `Loyalty stamp for order ${payload.orderId} failed: ${(err as Error).message}`,
      );
    }
  }

  async awardForOrder(orderId: string): Promise<{ stamped: boolean; earnedReward: boolean }> {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      select: {
        id: true,
        tenantId: true,
        locationId: true,
        customerAccountId: true,
        subtotal: true,
        total: true,
        status: true,
      },
    });
    const none = { stamped: false, earnedReward: false };
    // Anything at or past acceptance counts — a shop that goes straight to
    // PREPARING, or an order completed by a tab closing, has still accepted it.
    if (!order || !EARNING.has(order.status)) return none;
    // Guest checkouts cannot hold a card — there is nobody to give it to.
    if (!order.customerAccountId) return none;

    const card = await this.prisma.loyaltyCard.findUnique({
      where: { locationId: order.locationId },
    });
    if (!card?.isActive) return none;

    // Subtotal, not total: a delivery fee is not the customer spending money
    // with the shop, and counting it would let fees buy stamps.
    const spend = Number(order.subtotal ?? order.total ?? 0);
    if (card.minimumSpend != null && spend < Number(card.minimumSpend)) {
      return none;
    }

    try {
      await this.prisma.loyaltyStamp.create({
        data: {
          tenantId: order.tenantId,
          cardId: card.id,
          customerAccountId: order.customerAccountId,
          orderId: order.id,
          spend,
        },
      });
    } catch (err) {
      // P2002: this order already carries a stamp. Not an error — it is the
      // constraint doing its job on a replay.
      if ((err as { code?: string }).code === "P2002") return none;
      throw err;
    }

    const earnedReward = await this.maybeMintReward(
      card,
      order.customerAccountId,
    );
    return { stamped: true, earnedReward };
  }

  /**
   * Take back the stamp an order earned.
   *
   * If it had completed a card, the reward goes too — but only while it is
   * still UNCLAIMED. Once someone has eaten the free chicken, clawing it back
   * over a cancelled order is a worse outcome than absorbing it.
   */
  async revokeForOrder(orderId: string): Promise<void> {
    const stamp = await this.prisma.loyaltyStamp.findUnique({
      where: { orderId },
      select: { id: true, cardId: true, customerAccountId: true },
    });
    if (!stamp) return;

    await this.prisma.loyaltyStamp.delete({ where: { id: stamp.id } });

    const card = await this.prisma.loyaltyCard.findUnique({
      where: { id: stamp.cardId },
      select: { id: true, stampsRequired: true },
    });
    if (!card) return;

    const [stamps, rewards] = await Promise.all([
      this.prisma.loyaltyStamp.count({
        where: { cardId: card.id, customerAccountId: stamp.customerAccountId },
      }),
      this.prisma.loyaltyReward.count({
        where: { cardId: card.id, customerAccountId: stamp.customerAccountId },
      }),
    ]);

    // One reward too many for the stamps that remain.
    if (rewards > Math.floor(stamps / card.stampsRequired)) {
      const spare = await this.prisma.loyaltyReward.findFirst({
        where: {
          cardId: card.id,
          customerAccountId: stamp.customerAccountId,
          claimedAt: null,
        },
        orderBy: { earnedAt: "desc" },
      });
      if (spare) {
        await this.prisma.loyaltyReward.delete({ where: { id: spare.id } });
        this.logger.log(
          `Reward ${spare.id} withdrawn — order ${orderId} was cancelled`,
        );
      }
    }
    this.logger.log(`Stamp for order ${orderId} withdrawn`);
  }

  /**
   * Turn a full card into a reward.
   *
   * Counts stamps against rewards already earned rather than resetting a
   * counter, so a customer who is mid-way through their second card keeps
   * their progress and nothing has to be zeroed.
   */
  private async maybeMintReward(
    card: {
      id: string;
      tenantId: string;
      locationId: string;
      stampsRequired: number;
      rewardLabel: string;
      rewardItemId: string | null;
      rewardExpiryDays: number | null;
    },
    customerAccountId: string,
  ): Promise<boolean> {
    const [stamps, rewards] = await Promise.all([
      this.prisma.loyaltyStamp.count({
        where: { cardId: card.id, customerAccountId },
      }),
      this.prisma.loyaltyReward.count({
        where: { cardId: card.id, customerAccountId },
      }),
    ]);

    const earned = Math.floor(stamps / card.stampsRequired);
    if (earned <= rewards) return false;

    await this.prisma.loyaltyReward.create({
      data: {
        tenantId: card.tenantId,
        cardId: card.id,
        // Also stamped on the reward itself. Referral rewards come from no
        // card at all, so a reward has to know its own shop.
        locationId: card.locationId,
        source: "LOYALTY",
        customerAccountId,
        // Frozen. Tomorrow's offer does not rewrite today's promise.
        label: card.rewardLabel,
        rewardItemId: card.rewardItemId,
        expiresAt: card.rewardExpiryDays
          ? new Date(Date.now() + card.rewardExpiryDays * 86_400_000)
          : null,
      },
    });
    return true;
  }

  // ── Customer side ────────────────────────────────────────────────────────

  /** The customer's card at this location: progress and what they can claim. */
  async cardFor(customerAccountId: string, locationId: string) {
    const card = await this.prisma.loyaltyCard.findUnique({
      where: { locationId },
      include: { rewardItem: { select: { id: true, name: true, imageUrl: true } } },
    });
    if (!card?.isActive) return { active: false as const };

    const [stamps, rewards] = await Promise.all([
      this.prisma.loyaltyStamp.count({
        where: { cardId: card.id, customerAccountId },
      }),
      // Every unclaimed reward at this shop, whatever earned it — the card
      // and a referral both land here, and a customer does not care which.
      this.prisma.loyaltyReward.findMany({
        where: { locationId, customerAccountId, claimedAt: null },
        orderBy: { earnedAt: "asc" },
      }),
    ]);

    const live = rewards.filter((r) => !r.expiresAt || r.expiresAt > new Date());

    return {
      active: true as const,
      stampsRequired: card.stampsRequired,
      // Where they are on the CURRENT card, not the lifetime total — that is
      // the number the row of stamps has to draw.
      stamps: stamps % card.stampsRequired,
      lifetimeStamps: stamps,
      minimumSpend: card.minimumSpend ? Number(card.minimumSpend) : null,
      rewardLabel: card.rewardLabel,
      rewardItem: card.rewardItem,
      rewards: live.map((r) => ({
        id: r.id,
        label: r.label,
        rewardItemId: r.rewardItemId,
        source: r.source,
        amountOff: r.amountOff ? Number(r.amountOff) : null,
        earnedAt: r.earnedAt,
        expiresAt: r.expiresAt,
      })),
    };
  }

  /** Rewards this customer can spend at this location right now. */
  async claimableAt(customerAccountId: string, locationId: string) {
    const rewards = await this.prisma.loyaltyReward.findMany({
      where: {
        locationId,
        customerAccountId,
        claimedAt: null,
        OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
      },
      orderBy: { earnedAt: "asc" },
    });
    return rewards;
  }

  /**
   * Spend a reward on an order.
   *
   * claimedOrderId is unique, so an order can only ever carry one reward and a
   * double-submitted checkout cannot spend two.
   */
  async claim(customerAccountId: string, rewardId: string, orderId: string) {
    const reward = await this.prisma.loyaltyReward.findFirst({
      where: { id: rewardId, customerAccountId, claimedAt: null },
    });
    if (!reward) throw new NotFoundException("Reward not available");
    if (reward.expiresAt && reward.expiresAt <= new Date()) {
      throw new BadRequestException("That reward has expired.");
    }
    return this.prisma.loyaltyReward.update({
      where: { id: reward.id },
      data: { claimedAt: new Date(), claimedOrderId: orderId },
    });
  }

  private async brandIds(tenantId: string): Promise<string[]> {
    const brands = await this.prisma.brand.findMany({
      where: { tenantId, deletedAt: null },
      select: { id: true },
    });
    return brands.map((b) => b.id);
  }

  private async assertLocation(tenantId: string, locationId: string) {
    const found = await this.prisma.location.findFirst({
      where: { id: locationId, deletedAt: null, brand: { tenantId } },
      select: { id: true },
    });
    if (!found) throw new NotFoundException("Location not found");
  }
}
