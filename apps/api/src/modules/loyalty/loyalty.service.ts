import { BadRequestException, Injectable, Logger, NotFoundException, Optional } from "@nestjs/common";
import { EventEmitter2, OnEvent } from "@nestjs/event-emitter";
import { isStampIconKey } from "@orderhub/shared";
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

/** Who holds a card: a storefront account (online) or a walk-in member
 *  (wallet card scanned at the till). Exactly one is set. */
export type LoyaltyHolder = { customerAccountId: string } | { memberId: string };

/** Fired whenever a walk-in member's stamps or rewards change, so their
 *  Apple/Google Wallet pass can be refreshed. */
export const MEMBER_CHANGED = "loyalty.member_changed";

@Injectable()
export class LoyaltyService {
  private readonly logger = new Logger(LoyaltyService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Optional() private readonly events?: EventEmitter2,
  ) {}

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
      walkInEnabled: false,
      cardTitle: null,
      cardColor: null,
      cardLogoUrl: null,
      stampIcon: null,
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
      walkInEnabled?: boolean;
      cardTitle?: string | null;
      cardColor?: string | null;
      cardLogoUrl?: string | null;
      stampIcon?: string | null;
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
      // Walk-in card fields: only when sent, so an older dashboard saving the
      // online card cannot switch the walk-in card off.
      ...(dto.walkInEnabled !== undefined ? { walkInEnabled: !!dto.walkInEnabled } : {}),
      ...(dto.cardTitle !== undefined ? { cardTitle: dto.cardTitle?.trim().slice(0, 40) || null } : {}),
      ...(dto.cardColor !== undefined
        ? {
            cardColor:
              dto.cardColor && /^#[0-9a-fA-F]{6}$/.test(dto.cardColor) ? dto.cardColor.toUpperCase() : null,
          }
        : {}),
      ...(dto.cardLogoUrl !== undefined
        ? { cardLogoUrl: dto.cardLogoUrl && /^https:\/\//i.test(dto.cardLogoUrl) ? dto.cardLogoUrl : null }
        : {}),
      ...(dto.stampIcon !== undefined ? { stampIcon: isStampIconKey(dto.stampIcon) ? dto.stampIcon : null } : {}),
    };

    const saved = await this.prisma.loyaltyCard.upsert({
      where: { locationId },
      create: { tenantId, locationId, ...data },
      update: data,
      include: { rewardItem: { select: { id: true, name: true } } },
    });
    // Wallet passes already on people's phones show the name, colour and
    // reward — they follow the change.
    this.events?.emit("loyalty.card_changed", { locationId });
    return saved;
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
      // Any forward move re-checks: a walk-in card stamps as soon as the
      // order is PAID (a card-machine sale is held PENDING until the charge
      // lands, then accepted), so the customer sees it at the counter.
      // awardForOrder decides eligibility; the unique orderId makes the
      // repeat calls free.
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
        loyaltyMemberId: true,
        subtotal: true,
        total: true,
        status: true,
        paymentStatus: true,
      },
    });
    const none = { stamped: false, earnedReward: false };
    if (!order || REVOKING.has(order.status)) return none;
    // Guest checkouts cannot hold a card — there is nobody to give it to.
    const holder: LoyaltyHolder | null = order.customerAccountId
      ? { customerAccountId: order.customerAccountId }
      : order.loyaltyMemberId
        ? { memberId: order.loyaltyMemberId }
        : null;
    if (!holder) return none;
    // Online: only a finished order earns. Walk-in: the customer is standing
    // at the counter with the card on their phone, so it earns the moment it
    // is paid — and is still taken back by a cancel or refund like any other.
    const earning =
      EARNING.has(order.status) ||
      ("memberId" in holder && order.paymentStatus === "PAID");
    if (!earning) return none;

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
          ...holder,
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

    const earnedReward = await this.maybeMintReward(card, holder);
    this.memberChanged(holder);
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
      select: { id: true, cardId: true, customerAccountId: true, memberId: true },
    });
    if (!stamp) return;
    const holder: LoyaltyHolder | null = stamp.customerAccountId
      ? { customerAccountId: stamp.customerAccountId }
      : stamp.memberId
        ? { memberId: stamp.memberId }
        : null;

    await this.prisma.loyaltyStamp.delete({ where: { id: stamp.id } });

    const card = await this.prisma.loyaltyCard.findUnique({
      where: { id: stamp.cardId },
      select: { id: true, stampsRequired: true },
    });
    if (!card || !holder) return;
    this.memberChanged(holder);

    const [stamps, rewards] = await Promise.all([
      this.prisma.loyaltyStamp.count({
        where: { cardId: card.id, ...holder },
      }),
      this.prisma.loyaltyReward.count({
        where: { cardId: card.id, ...holder },
      }),
    ]);

    // One reward too many for the stamps that remain.
    if (rewards > Math.floor(stamps / card.stampsRequired)) {
      const spare = await this.prisma.loyaltyReward.findFirst({
        where: {
          cardId: card.id,
          ...holder,
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
    holder: LoyaltyHolder,
  ): Promise<boolean> {
    const [stamps, rewards] = await Promise.all([
      this.prisma.loyaltyStamp.count({
        where: { cardId: card.id, ...holder },
      }),
      this.prisma.loyaltyReward.count({
        where: { cardId: card.id, ...holder },
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
        ...holder,
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

  /** A walk-in card changed — its wallet pass has to follow. */
  private memberChanged(holder: LoyaltyHolder) {
    if ("memberId" in holder) this.events?.emit(MEMBER_CHANGED, { memberId: holder.memberId });
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
