import { BadRequestException, Injectable, Logger, NotFoundException } from "@nestjs/common";
import { OnEvent } from "@nestjs/event-emitter";
import { PrismaService } from "../../infrastructure/database/prisma.service";

// Refer a friend.
//
// A customer shares a code, a NEW customer orders, and both get money off. The
// reward lands on the same card the loyalty stamps do, because to a customer
// they are the same thing — something waiting that they spend once.
//
// ── Proving the number ──────────────────────────────────────────────────────
//
// The checks below all run on a phone number, and until it is verified they
// run on a number somebody typed. Typing 07999 000000 costs nothing.
//
// So the friend sends ONE WhatsApp message to the shop, from a wa.me link with
// the text already filled in. Meta only lets a message originate from a number
// registered on that device, so the `from` on the inbound webhook is a number
// the sender demonstrably holds — at least as strong as an SMS code, and
// harder to spoof.
//
// It costs nothing. Inbound messages are never billed, and the message opens a
// 24-hour service window, so the reply is free too. An outbound OTP would need
// a paid authentication template AND would put the number the ordering bot
// depends on at quality risk.
//
// Eligibility then runs against the VERIFIED number, not the typed one.
//
// ── "New" is the whole scheme ───────────────────────────────────────────────
//
// Everything else here is bookkeeping. An email address is free to create, so
// checking only for an existing account means a regular can pay themselves a
// discount whenever they fancy one. Qualification therefore checks the PHONE:
// against every other account, and against the order history — plenty of
// people order as guests for years before they ever sign up, and they are not
// new customers.
//
// ── Paid on COMPLETION, never at checkout ───────────────────────────────────
//
// An order cancelled or refunded afterwards must not have paid out two
// discounts, and money is harder to take back than a stamp.
//
// A shop that never presses the button still pays out: the 5am rollover
// completes anything in flight and calls this directly, because it completes
// orders with raw SQL and emits no event on purpose.
//
// ── Every limit exists because it is money ──────────────────────────────────
//
// A minimum spend, or a bag of chips triggers two payouts worth more than the
// order. A cap per referrer, or one person with a group chat is an unbounded
// liability. A friend can only be referred once, ever, whoever got there
// first.

/** No 0/O/1/I/5/S — these get read aloud and typed in by someone else. */
const ALPHABET = "ABCDEFGHJKLMNPQRTUVWXYZ2346789";

/** Only a finished order pays out. The 5am rollover makes that reachable. */
const EARNING = new Set(["COMPLETED"]);

export type ReferralRejection =
  | "ALREADY_A_CUSTOMER"
  | "PHONE_ALREADY_KNOWN"
  | "SELF_REFERRAL"
  | "REFERRER_AT_CAP"
  | "BELOW_MINIMUM_SPEND"
  | "NO_PHONE"
  | "NOT_VERIFIED";

@Injectable()
export class ReferralService {
  private readonly logger = new Logger(ReferralService.name);

  constructor(private readonly prisma: PrismaService) {}

  // ── Operator ─────────────────────────────────────────────────────────────

  async getProgram(tenantId: string, locationId: string) {
    await this.assertLocation(tenantId, locationId);
    const found = await this.prisma.referralProgram.findUnique({
      where: { locationId },
    });
    if (found) return found;
    // Not created on read. An operator opening the tab should not bring a
    // programme into being.
    return {
      locationId,
      isActive: false,
      referrerAmount: 5,
      friendAmount: 5,
      minimumSpend: null,
      maxPerCustomer: 10,
      rewardExpiryDays: null,
    };
  }

  async upsertProgram(
    tenantId: string,
    locationId: string,
    dto: {
      isActive?: boolean;
      referrerAmount?: number;
      friendAmount?: number;
      minimumSpend?: number | null;
      maxPerCustomer?: number;
      rewardExpiryDays?: number | null;
    },
  ) {
    await this.assertLocation(tenantId, locationId);

    const referrerAmount = Math.max(0, Number(dto.referrerAmount ?? 5));
    const friendAmount = Math.max(0, Number(dto.friendAmount ?? 5));
    if (dto.isActive && referrerAmount <= 0 && friendAmount <= 0) {
      throw new BadRequestException(
        "Set an amount for at least one side before switching referrals on.",
      );
    }

    const data = {
      isActive: dto.isActive ?? false,
      referrerAmount,
      friendAmount,
      minimumSpend:
        dto.minimumSpend === null || dto.minimumSpend === undefined
          ? null
          : Math.max(0, Number(dto.minimumSpend)),
      // Uncapped is not an option in the UI and is not one here either.
      maxPerCustomer: Math.min(500, Math.max(1, Math.round(dto.maxPerCustomer ?? 10))),
      rewardExpiryDays:
        dto.rewardExpiryDays === null || dto.rewardExpiryDays === undefined
          ? null
          : Math.max(1, Math.round(dto.rewardExpiryDays)),
    };

    return this.prisma.referralProgram.upsert({
      where: { locationId },
      create: { tenantId, locationId, ...data },
      update: data,
    });
  }

  // ── Customer: getting a code ─────────────────────────────────────────────

  /**
   * This customer's code for this shop, minted on first ask.
   *
   * One code, reused for every friend — it is shared in a group chat, not
   * handed out one at a time. What is one-time is the reward it produces.
   */
  async myCode(customerAccountId: string, locationId: string) {
    const program = await this.prisma.referralProgram.findUnique({
      where: { locationId },
    });
    if (!program?.isActive) return { active: false as const };

    const existing = await this.prisma.referralCode.findUnique({
      where: {
        programId_customerAccountId: {
          programId: program.id,
          customerAccountId,
        },
      },
    });

    const code =
      existing ??
      (await this.prisma.referralCode.create({
        data: {
          tenantId: program.tenantId,
          programId: program.id,
          customerAccountId,
          code: await this.uniqueCode(),
        },
      }));

    const [used, pending] = await Promise.all([
      this.prisma.referral.count({
        where: { codeId: code.id, status: "QUALIFIED" },
      }),
      this.prisma.referral.count({
        where: { codeId: code.id, status: "PENDING" },
      }),
    ]);

    return {
      active: true as const,
      code: code.code,
      referrerAmount: Number(program.referrerAmount),
      friendAmount: Number(program.friendAmount),
      minimumSpend: program.minimumSpend ? Number(program.minimumSpend) : null,
      // Both counts, because "3 friends joined" and "2 have not ordered yet"
      // are different facts and the second one explains the wait.
      qualified: used,
      pending,
      remaining: Math.max(0, program.maxPerCustomer - used),
    };
  }

  // ── Customer: using someone's code ───────────────────────────────────────

  /**
   * Attach a friend to a code. Records the intent; pays nothing yet.
   *
   * Checked HERE so the friend is told at signup rather than discovering after
   * an order that they were never eligible — but checked again at
   * qualification, because time passes and an account can be edited.
   */
  async claimCode(args: {
    customerAccountId: string;
    locationId: string;
    code: string;
  }) {
    const program = await this.prisma.referralProgram.findUnique({
      where: { locationId: args.locationId },
    });
    if (!program?.isActive) {
      throw new BadRequestException("This shop isn't running referrals.");
    }

    const referralCode = await this.prisma.referralCode.findFirst({
      where: { code: args.code.trim().toUpperCase(), programId: program.id },
    });
    if (!referralCode) throw new NotFoundException("That code isn't recognised.");

    if (referralCode.customerAccountId === args.customerAccountId) {
      throw new BadRequestException("That's your own code.");
    }

    const friend = await this.prisma.customerAccount.findUnique({
      where: { id: args.customerAccountId },
      select: { id: true, phone: true },
    });
    if (!friend) throw new NotFoundException("Account not found");

    const rejection = await this.eligibility({
      friendId: friend.id,
      friendPhone: friend.phone,
      referrerId: referralCode.customerAccountId,
      tenantId: program.tenantId,
      programId: program.id,
      maxPerCustomer: program.maxPerCustomer,
    });
    if (rejection) throw new BadRequestException(this.explain(rejection));

    const verifyToken = await this.uniqueVerifyToken();
    try {
      await this.prisma.referral.create({
        data: {
          tenantId: program.tenantId,
          programId: program.id,
          codeId: referralCode.id,
          referrerAccountId: referralCode.customerAccountId,
          friendAccountId: friend.id,
          friendPhone: normalisePhone(friend.phone),
          verifyToken,
        },
      });
    } catch (err) {
      // friendAccountId is unique: someone else's code reached them first.
      if ((err as { code?: string }).code === "P2002") {
        throw new BadRequestException("You've already been referred.");
      }
      throw err;
    }

    // Where the shop has WhatsApp, the friend proves the number before
    // anything pays out. Where it does not, the unverified checks stand — a
    // shop with no WhatsApp should not simply be unable to run referrals.
    const wa = await this.whatsAppNumberFor(args.locationId);
    return {
      ok: true,
      friendAmount: Number(program.friendAmount),
      verification: wa
        ? {
            required: true as const,
            // Pre-filled, so the friend taps twice and types nothing.
            url: `https://wa.me/${wa}?text=${encodeURIComponent(`VERIFY ${verifyToken}`)}`,
          }
        : { required: false as const },
    };
  }

  /**
   * A friend's WhatsApp message, proving the number.
   *
   * Called from the inbound router BEFORE the ordering AI sees the message —
   * otherwise "VERIFY 7QK2" is answered as an attempt to order something.
   *
   * Returns the line to reply with, or null when the message was not one of
   * ours and should carry on to the AI.
   */
  async verifyFromWhatsApp(
    text: string,
    fromPhone: string,
  ): Promise<string | null> {
    const match = /^\s*verify\s+([a-z0-9]{4,10})\s*$/i.exec(text ?? "");
    if (!match) return null;

    const token = match[1]!.toUpperCase();
    const referral = await this.prisma.referral.findFirst({
      where: { verifyToken: token },
      include: { program: true },
    });
    // A wrong or expired token is still OUR message to answer — falling
    // through would have the ordering bot try to sell them something.
    if (!referral) return "That verification code isn't recognised.";
    if (referral.verifiedAt) return "You're already verified.";

    const phone = normalisePhone(fromPhone);
    if (!phone) return "We couldn't read your number. Please try again.";

    // The number they MESSAGED FROM replaces the number they typed, and the
    // checks re-run against it. This is the entire point.
    const rejection = await this.eligibility({
      friendId: referral.friendAccountId,
      friendPhone: phone,
      referrerId: referral.referrerAccountId,
      tenantId: referral.tenantId,
      programId: referral.programId,
      maxPerCustomer: referral.program.maxPerCustomer,
    });
    if (rejection) {
      await this.prisma.referral.update({
        where: { id: referral.id },
        data: { status: "REJECTED", rejectedReason: rejection },
      });
      return this.explain(rejection);
    }

    await this.prisma.referral.update({
      where: { id: referral.id },
      data: { verifiedPhone: phone, verifiedAt: new Date(), friendPhone: phone },
    });

    const amount = Number(referral.program.friendAmount);
    return amount > 0
      ? `Verified. ${money(amount)} lands on your card once your first order is complete.`
      : "Verified.";
  }

  /** The shop's own WhatsApp number, digits only, for a wa.me link. */
  private async whatsAppNumberFor(locationId: string): Promise<string | null> {
    const integration = await this.prisma.integration.findUnique({
      where: {
        locationId_platform: { locationId, platform: "WHATSAPP" as never },
      },
      select: { settings: true },
    });
    const display = (integration?.settings as any)?.displayPhoneNumber;
    return normalisePhone(display);
  }

  private async uniqueVerifyToken(): Promise<string> {
    for (let attempt = 0; attempt < 8; attempt++) {
      const token = Array.from(
        { length: 5 },
        () => ALPHABET[Math.floor(Math.random() * ALPHABET.length)],
      ).join("");
      const clash = await this.prisma.referral.findFirst({
        where: { verifyToken: token },
        select: { id: true },
      });
      if (!clash) return token;
    }
    throw new Error("Could not mint a unique verification token");
  }

  // ── Qualification ────────────────────────────────────────────────────────

  @OnEvent("order.status_changed")
  async onOrderStatusChanged(payload: { orderId?: string; toStatus?: string }) {
    // `toStatus` — the field OrdersService.updateStatus actually emits.
    if (payload?.toStatus !== "COMPLETED" || !payload.orderId) return;
    try {
      await this.qualifyForOrder(payload.orderId);
    } catch (err) {
      this.logger.warn(
        `Referral qualification for order ${payload.orderId} failed: ${(err as Error).message}`,
      );
    }
  }

  /**
   * A completed order may be a friend's first, and may pay out.
   *
   * Re-checks everything claimCode checked. An account's phone can be edited
   * between claiming a code and ordering, and the gap between those two
   * moments is exactly where someone would try.
   */
  async qualifyForOrder(orderId: string): Promise<boolean> {
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
        createdAt: true,
      },
    });
    if (!order || !order.customerAccountId) return false;
    if (!EARNING.has(order.status)) return false;

    const referral = await this.prisma.referral.findFirst({
      where: {
        friendAccountId: order.customerAccountId,
        status: "PENDING",
        program: { locationId: order.locationId, isActive: true },
      },
      include: { program: true },
    });
    if (!referral) return false;

    const program = referral.program;
    const spend = Number(order.subtotal ?? order.total ?? 0);
    if (program.minimumSpend != null && spend < Number(program.minimumSpend)) {
      // Not rejected — they may well order properly next time.
      this.logger.log(
        `Referral ${referral.id} not paid: ${spend} below minimum ${program.minimumSpend}`,
      );
      return false;
    }

    const friend = await this.prisma.customerAccount.findUnique({
      where: { id: order.customerAccountId },
      select: { id: true, phone: true },
    });

    // Unverified pays nothing, wherever the shop can verify.
    //
    // Held rather than rejected: the friend can still send the message
    // afterwards, and the reward is waiting when they do. Rejecting here would
    // punish somebody who ordered before finishing a step we asked for.
    const wa = await this.whatsAppNumberFor(order.locationId);
    if (wa && !referral.verifiedAt) {
      this.logger.log(
        `Referral ${referral.id} held: number not verified on WhatsApp yet`,
      );
      return false;
    }

    const rejection = await this.eligibility({
      friendId: order.customerAccountId,
      // The VERIFIED number when we have one. What they typed is only ever a
      // fallback for a shop that cannot verify at all.
      friendPhone: referral.verifiedPhone ?? friend?.phone ?? referral.friendPhone,
      referrerId: referral.referrerAccountId,
      tenantId: order.tenantId,
      programId: program.id,
      maxPerCustomer: program.maxPerCustomer,
      // This very order is the friend's first, so it must not count against
      // them when we look for prior orders from their phone.
      ignoreOrderId: order.id,
    });
    if (rejection) {
      await this.prisma.referral.update({
        where: { id: referral.id },
        data: { status: "REJECTED", rejectedReason: rejection },
      });
      this.logger.log(`Referral ${referral.id} rejected: ${rejection}`);
      return false;
    }

    // Both rewards and the status move together. A payout to one side only is
    // the worst outcome available — someone is owed money nobody can see.
    await this.prisma.$transaction([
      this.prisma.referral.update({
        where: { id: referral.id },
        data: {
          status: "QUALIFIED",
          qualifiedAt: new Date(),
          qualifyingOrderId: order.id,
        },
      }),
      ...this.rewardWrites({
        tenantId: order.tenantId,
        locationId: order.locationId,
        expiryDays: program.rewardExpiryDays,
        rows: [
          {
            customerAccountId: referral.referrerAccountId,
            amount: Number(program.referrerAmount),
            label: `${money(Number(program.referrerAmount))} off — thanks for the referral`,
          },
          {
            customerAccountId: referral.friendAccountId,
            amount: Number(program.friendAmount),
            label: `${money(Number(program.friendAmount))} off — welcome`,
          },
        ],
      }),
    ]);

    return true;
  }

  private rewardWrites(args: {
    tenantId: string;
    locationId: string;
    expiryDays: number | null;
    rows: Array<{ customerAccountId: string; amount: number; label: string }>;
  }) {
    const expiresAt = args.expiryDays
      ? new Date(Date.now() + args.expiryDays * 86_400_000)
      : null;
    return args.rows
      // A side set to zero pays out nothing rather than an empty reward.
      .filter((r) => r.amount > 0)
      .map((r) =>
        this.prisma.loyaltyReward.create({
          data: {
            tenantId: args.tenantId,
            locationId: args.locationId,
            customerAccountId: r.customerAccountId,
            source: "REFERRAL",
            amountOff: r.amount,
            label: r.label,
            expiresAt,
          },
        }),
      );
  }

  /**
   * Is this friend genuinely new, and has the referrer room left?
   *
   * Returns the reason rather than a boolean, because every one of these needs
   * different words in front of a customer and different handling in a report.
   */
  private async eligibility(args: {
    friendId: string;
    friendPhone: string | null | undefined;
    referrerId: string;
    tenantId: string;
    programId: string;
    maxPerCustomer: number;
    ignoreOrderId?: string;
  }): Promise<ReferralRejection | null> {
    if (args.friendId === args.referrerId) return "SELF_REFERRAL";

    const phone = normalisePhone(args.friendPhone);
    // NO PHONE, NO REFERRAL.
    //
    // Every check below runs on the phone, and CustomerAccount.phone is
    // optional — so treating "no phone" as eligible made an account with the
    // field left blank the easiest way through the whole scheme. Absence of
    // evidence is not eligibility when the evidence is the point.
    if (!phone) return "NO_PHONE";
    {
      const referrer = await this.prisma.customerAccount.findUnique({
        where: { id: args.referrerId },
        select: { phone: true },
      });
      // The same phone on both sides is one person with two email addresses.
      if (normalisePhone(referrer?.phone) === phone) return "SELF_REFERRAL";

      const otherAccount = await this.prisma.customerAccount.findFirst({
        where: { phone: { not: null }, id: { not: args.friendId } },
        select: { id: true, phone: true },
        // Compared in memory: numbers are stored however they were typed, and
        // a SQL equality on the raw string would miss "07700 900123" against
        // "+447700900123".
      });
      if (otherAccount && normalisePhone(otherAccount.phone) === phone) {
        return "PHONE_ALREADY_KNOWN";
      }

      // The real check. Someone who has been ordering as a guest for two years
      // is not a new customer, whatever their email address says.
      const priorOrders = await this.prisma.order.findMany({
        where: {
          tenantId: args.tenantId,
          ...(args.ignoreOrderId ? { id: { not: args.ignoreOrderId } } : {}),
          OR: [
            { customerAccountId: args.friendId },
            { customer: { phone: { not: null } } },
          ],
        },
        select: { id: true, customerAccountId: true, customer: { select: { phone: true } } },
        take: 500,
      });
      const seenBefore = priorOrders.some(
        (o) =>
          o.customerAccountId === args.friendId ||
          normalisePhone(o.customer?.phone) === phone,
      );
      if (seenBefore) return "ALREADY_A_CUSTOMER";
    }

    const qualified = await this.prisma.referral.count({
      where: {
        programId: args.programId,
        referrerAccountId: args.referrerId,
        status: "QUALIFIED",
      },
    });
    if (qualified >= args.maxPerCustomer) return "REFERRER_AT_CAP";

    return null;
  }

  private explain(r: ReferralRejection): string {
    switch (r) {
      case "SELF_REFERRAL":
        return "A referral code can't be used on your own account.";
      case "PHONE_ALREADY_KNOWN":
        return "That phone number is already on an account with us.";
      case "ALREADY_A_CUSTOMER":
        return "Referral codes are for customers ordering with us for the first time.";
      case "REFERRER_AT_CAP":
        return "Your friend has reached their referral limit.";
      case "BELOW_MINIMUM_SPEND":
        return "That order didn't reach the minimum for a referral reward.";
      case "NO_PHONE":
        return "Add a mobile number to your account to use a referral code.";
      case "NOT_VERIFIED":
        return "Verify your number on WhatsApp to unlock your reward.";
    }
  }

  private async uniqueCode(): Promise<string> {
    for (let attempt = 0; attempt < 8; attempt++) {
      const code = Array.from(
        { length: 6 },
        () => ALPHABET[Math.floor(Math.random() * ALPHABET.length)],
      ).join("");
      const clash = await this.prisma.referralCode.findUnique({ where: { code } });
      if (!clash) return code;
    }
    // 30^6 is 729 million; eight collisions means something is wrong rather
    // than unlucky, and a caller should hear about it.
    throw new Error("Could not mint a unique referral code");
  }

  private async assertLocation(tenantId: string, locationId: string) {
    const found = await this.prisma.location.findFirst({
      where: { id: locationId, deletedAt: null, brand: { tenantId } },
      select: { id: true },
    });
    if (!found) throw new NotFoundException("Location not found");
  }
}

/** Digits only, and a UK 0 prefix folded onto 44, so "07700 900123",
 *  "+44 7700 900123" and "447700900123" are one person. */
export function normalisePhone(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let d = String(raw).replace(/\D/g, "");
  if (!d) return null;
  if (d.startsWith("0")) d = `44${d.slice(1)}`;
  return d;
}

const money = (n: number) => `£${n.toFixed(2).replace(/\.00$/, "")}`;
