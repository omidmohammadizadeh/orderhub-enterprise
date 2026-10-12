import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from "@nestjs/common";
import { EventEmitter2, OnEvent } from "@nestjs/event-emitter";
import { createHash, randomInt, timingSafeEqual } from "crypto";
import { PrismaService } from "../../../infrastructure/database/prisma.service";
import { EmailService } from "../../../infrastructure/email/email.service";
import { SmsService } from "../../sms/sms.service";
import { toE164 } from "../../sms/phone";
import { LoyaltyService, MEMBER_CHANGED } from "../loyalty.service";
import { ApplePassService } from "./apple-pass.service";
import { GoogleWalletService } from "./google-wallet.service";
import { safeColor } from "./pass-art";
import type { PassView } from "./pass-view";
import { newMemberCode, newPublicToken, parseMemberCode, scanValue } from "./walk-in-codes";
import { cardEmail, codeEmail } from "./walk-in-emails";

// Walk-in loyalty cards.
//
// The online stamp card needs a storefront login, which a coffee-shop
// customer paying at the counter will never make. This is the same card —
// same stamps, same reward, same LoyaltyCard row — held on the customer's
// phone instead: a card page, an Apple/Google Wallet pass, and a QR the till
// scans.
//
// ── Joining ─────────────────────────────────────────────────────────────────
// From the QR poster at the counter (/loyalty/join/<shop>), or by staff at the
// till. EMAIL is the key: one address, one card per shop, and everything we
// send (the card link, the code) goes by email because it costs nothing. If the
// address already has a card — a new phone, a second phone, a deleted pass — we
// email a 6-digit code and open the SAME card once it is typed in. Never
// straight on screen: anyone could type a regular's address and walk off with
// their free coffee.
//
// Phone was the key before email. Members who joined with a number keep
// working — looked up by phone, sent texts — and nothing new asks for one.
//
// ── Earning and spending ────────────────────────────────────────────────────
// The till scans the pass and sends loyaltyMemberId (and loyaltyRewardId when a
// reward is being spent) with the order. OrdersService calls attachOrder();
// LoyaltyService.awardForOrder stamps it as soon as the order is paid, and
// takes it back on a cancel or refund like any other stamp.

const MEMBER_LOOKUP_SELECT = {
  id: true,
  tenantId: true,
  cardId: true,
  locationId: true,
  code: true,
  publicToken: true,
  phone: true,
  email: true,
  firstName: true,
  passUpdatedAt: true,
  googleObjectAt: true,
} as const;

type CardWithShop = NonNullable<Awaited<ReturnType<WalkInLoyaltyService["loadCard"]>>>;

/** How a member is found and reached: an email (current) or a phone (older). */
type Contact = { email: string } | { phone: string };

type Reachable = { id: string; publicToken: string; email: string | null; phone: string | null; firstName: string | null };

export function normaliseEmail(raw: string | null | undefined): string | null {
  const v = String(raw ?? "").trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v) && v.length <= 254 ? v : null;
}

/** "om•••@gmail.com" / "•••• 709" — enough to recognise, not to harvest. */
export function contactHint(m: { email: string | null; phone: string | null }): string | null {
  if (m.email) {
    const [user, domain] = m.email.split("@");
    return `${user!.slice(0, 2)}•••@${domain}`;
  }
  return m.phone ? `•••• ${m.phone.slice(-3)}` : null;
}

@Injectable()
export class WalkInLoyaltyService {
  private readonly logger = new Logger(WalkInLoyaltyService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly loyalty: LoyaltyService,
    private readonly sms: SmsService,
    private readonly apple: ApplePassService,
    private readonly google: GoogleWalletService,
    private readonly events: EventEmitter2,
    private readonly mail: EmailService,
  ) {}

  // ── Public: joining ──────────────────────────────────────────────────────

  /** What the counter QR poster's page shows before anyone signs up. */
  async joinInfo(shop: string) {
    const location = await this.resolveShop(shop);
    const card = await this.loadCard(location.id);
    const title = card ? this.titleOf(card) : location.name.trim();
    if (!card || !card.isActive || !card.walkInEnabled) {
      return { available: false as const, title };
    }
    return {
      available: true as const,
      title,
      color: safeColor(card.cardColor),
      stampIcon: card.stampIcon,
      logoUrl: this.logoOf(card),
      stampsRequired: card.stampsRequired,
      rewardLabel: this.rewardLabelOf(card),
      earnRule: this.earnRule(card),
      expiryNote: this.expiryNote(card),
    };
  }

  async join(
    shop: string,
    dto: { firstName?: string; email?: string; phone?: string; marketingConsent?: boolean },
  ): Promise<
    | { status: "CREATED"; token: string }
    | { status: "VERIFY"; contactHint: string; via: "email" | "sms" }
    | { status: "EXISTING"; sent: false }
  > {
    const location = await this.resolveShop(shop);
    const card = await this.loadCard(location.id);
    if (!card || !card.isActive || !card.walkInEnabled) {
      throw new BadRequestException("This shop isn't running a loyalty card right now.");
    }
    const contact = this.contactFrom(dto, "Enter a valid email address.");
    const firstName = this.cleanName(dto.firstName);

    const existing = await this.findByContact(card.id, contact);
    if (existing) {
      // Never on screen: whoever typed this may not own it. A code sent to it
      // proves they do, and opens the same card on this device.
      const sent = await this.sendVerifyCode(existing, card);
      if (!sent) return { status: "EXISTING", sent: false };
      return { status: "VERIFY", contactHint: contactHint(existing)!, via: existing.email ? "email" : "sms" };
    }

    const member = await this.createMember(card, { ...contact, firstName, source: "SELF" });
    if (dto.marketingConsent) this.emitConsent(card, contact, firstName);
    // They have the card on screen now; the email is so they can find it again.
    void this.sendCardLink(member, card, "welcome");
    return { status: "CREATED", token: member.publicToken };
  }

  /** The emailed (or texted) code, typed on the phone that wants the card. */
  async verify(shop: string, dto: { email?: string; phone?: string; code?: string }): Promise<{ token: string }> {
    const location = await this.resolveShop(shop);
    const card = await this.loadCard(location.id);
    const code = String(dto.code ?? "").replace(/\D/g, "");
    const wrong = new BadRequestException("That code isn't right. Check it and try again.");
    const email = normaliseEmail(dto.email);
    const phone = email ? null : toE164(dto.phone);
    if (!card || (!email && !phone) || code.length !== 6) throw wrong;

    const member = await this.prisma.loyaltyMember.findUnique({
      where: email ? { cardId_email: { cardId: card.id, email } } : { cardId_phone: { cardId: card.id, phone: phone! } },
      select: { id: true, publicToken: true, verifyCodeHash: true, verifyExpiresAt: true, verifyAttempts: true },
    });
    if (!member?.verifyCodeHash || !member.verifyExpiresAt || member.verifyExpiresAt < new Date()) {
      throw new BadRequestException("That code has expired. Ask for a new one.");
    }
    if (member.verifyAttempts >= 5) {
      throw new BadRequestException("Too many tries. Ask for a new code.");
    }
    const given = Buffer.from(this.hashCode(member.id, code), "hex");
    const stored = Buffer.from(member.verifyCodeHash, "hex");
    if (given.length !== stored.length || !timingSafeEqual(given, stored)) {
      await this.prisma.loyaltyMember.update({
        where: { id: member.id },
        data: { verifyAttempts: { increment: 1 } },
      });
      throw wrong;
    }
    await this.prisma.loyaltyMember.update({
      where: { id: member.id },
      data: { verifyCodeHash: null, verifyExpiresAt: null, verifyAttempts: 0 },
    });
    return { token: member.publicToken };
  }

  // ── Storefront account → wallet card ─────────────────────────────────────

  /**
   * A signed-in online customer opening their Rewards page. Finds (or makes)
   * their wallet card at this shop and links it to the account — matching an
   * in-store card they already hold by email — then joins the two halves of
   * their history so online orders and till visits fill ONE card and ONE pass.
   * Returns the card link token for the page to show and add to a wallet.
   */
  async linkAccount(customerAccountId: string, locationId: string): Promise<{ token: string }> {
    const card = await this.loadCard(locationId);
    if (!card?.isActive) throw new BadRequestException("This shop isn't running a loyalty card right now.");

    const linked = await this.prisma.loyaltyMember.findUnique({
      where: { cardId_customerAccountId: { cardId: card.id, customerAccountId } },
      select: { id: true, publicToken: true },
    });
    if (linked) return { token: linked.publicToken };

    const account = await this.prisma.customerAccount.findUnique({
      where: { id: customerAccountId },
      select: { email: true, firstName: true },
    });
    if (!account) throw new NotFoundException("Account not found");
    const email = normaliseEmail(account.email);

    // Already joined in store with the same email: that card becomes theirs.
    const byEmail = email
      ? await this.prisma.loyaltyMember.findUnique({
          where: { cardId_email: { cardId: card.id, email } },
          select: { id: true, publicToken: true, customerAccountId: true },
        })
      : null;

    let member: { id: string; publicToken: string };
    if (byEmail && !byEmail.customerAccountId) {
      member = await this.prisma.loyaltyMember.update({
        where: { id: byEmail.id },
        data: { customerAccountId },
        select: { id: true, publicToken: true },
      });
    } else {
      // A fresh card. It keeps the account's email unless another card here
      // already uses it (linked to a different account) — then the link alone.
      member = await this.createMember(card, {
        ...(email && !byEmail ? { email } : {}),
        customerAccountId,
        firstName: this.cleanName(account.firstName),
        source: "ONLINE",
      } as { email: string } & { customerAccountId: string; firstName: string | null; source: "ONLINE" });
    }

    // Join the two histories: every stamp and reward now carries both ids.
    await this.prisma.$transaction([
      this.prisma.loyaltyStamp.updateMany({
        where: { cardId: card.id, customerAccountId, memberId: null },
        data: { memberId: member.id },
      }),
      this.prisma.loyaltyStamp.updateMany({
        where: { cardId: card.id, memberId: member.id, customerAccountId: null },
        data: { customerAccountId },
      }),
      this.prisma.loyaltyReward.updateMany({
        where: { locationId: card.locationId, customerAccountId, memberId: null },
        data: { memberId: member.id },
      }),
      this.prisma.loyaltyReward.updateMany({
        where: { locationId: card.locationId, memberId: member.id, customerAccountId: null },
        data: { customerAccountId },
      }),
    ]);
    await this.loyalty.settleRewards(card.id, { memberId: member.id });
    this.events.emit(MEMBER_CHANGED, { memberId: member.id });
    return { token: member.publicToken };
  }

  // ── Public: the customer's card ──────────────────────────────────────────

  async publicCard(token: string) {
    const { member, card } = await this.memberByToken(token);
    const view = await this.view(member, card);
    void this.prisma.loyaltyMember
      .update({ where: { id: member.id }, data: { lastSeenAt: new Date() } })
      .catch(() => undefined);
    const rewards = await this.liveRewards(member.id, card.locationId);
    return {
      title: view.title,
      color: view.color,
      stampIcon: view.stampIcon,
      logoUrl: view.logoUrl,
      firstName: member.firstName,
      code: member.code,
      scan: scanValue(member.code),
      stamps: view.stamps,
      stampsRequired: view.stampsRequired,
      rewardLabel: view.rewardLabel,
      earnRule: view.earnRule,
      expiryNote: view.expiryNote,
      active: card.isActive && card.walkInEnabled,
      rewards: rewards.map((r) => ({ id: r.id, label: r.label, expiresAt: r.expiresAt })),
      wallet: { apple: this.apple.configured(), google: this.google.configured() },
    };
  }

  async applePass(token: string): Promise<Buffer> {
    if (!this.apple.configured()) throw new BadRequestException("Apple Wallet isn't set up yet.");
    const { member, card } = await this.memberByToken(token);
    return this.apple.build(await this.view(member, card));
  }

  async googleSaveUrl(token: string): Promise<{ url: string }> {
    if (!this.google.configured()) throw new BadRequestException("Google Wallet isn't set up yet.");
    const { member, card } = await this.memberByToken(token);
    const url = this.google.saveUrl(await this.view(member, card));
    // From here on, a stamp PATCHes the object. If they never tap Save, the
    // PATCH 404s and is ignored.
    await this.prisma.loyaltyMember.update({ where: { id: member.id }, data: { googleObjectAt: new Date() } });
    return { url };
  }

  // ── Apple PassKit web service ────────────────────────────────────────────

  async registerDevice(deviceId: string, passTypeId: string, serial: string, auth: string | undefined, pushToken: string) {
    const member = await this.passAuth(passTypeId, serial, auth);
    if (!pushToken) throw new BadRequestException("pushToken required");
    const existing = await this.prisma.loyaltyPassDevice.findUnique({
      where: { deviceLibraryId_memberId: { deviceLibraryId: deviceId, memberId: member.id } },
    });
    if (existing) {
      if (existing.pushToken !== pushToken) {
        await this.prisma.loyaltyPassDevice.update({ where: { id: existing.id }, data: { pushToken } });
      }
      return { created: false };
    }
    await this.prisma.loyaltyPassDevice.create({
      data: { deviceLibraryId: deviceId, memberId: member.id, pushToken },
    });
    return { created: true };
  }

  async unregisterDevice(deviceId: string, passTypeId: string, serial: string, auth: string | undefined) {
    const member = await this.passAuth(passTypeId, serial, auth);
    await this.prisma.loyaltyPassDevice.deleteMany({ where: { deviceLibraryId: deviceId, memberId: member.id } });
  }

  /** Apple asks "which of my passes changed since <tag>?". The tag is ours. */
  async changedSerials(deviceId: string, passTypeId: string, since: string | undefined) {
    if (passTypeId !== this.apple.passTypeId) return null;
    const devices = await this.prisma.loyaltyPassDevice.findMany({
      where: { deviceLibraryId: deviceId },
      select: { member: { select: { id: true, passUpdatedAt: true } } },
    });
    const sinceMs = since && /^\d+$/.test(since) ? Number(since) : 0;
    const changed = devices.map((d) => d.member).filter((m) => m.passUpdatedAt.getTime() > sinceMs);
    if (!changed.length) return null;
    const latest = Math.max(...changed.map((m) => m.passUpdatedAt.getTime()));
    return { serialNumbers: changed.map((m) => m.id), lastUpdated: String(latest) };
  }

  async latestApplePass(passTypeId: string, serial: string, auth: string | undefined) {
    const member = await this.passAuth(passTypeId, serial, auth);
    const card = await this.loadCard(member.locationId);
    if (!card) throw new NotFoundException();
    const buffer = await this.apple.build(await this.view(member, card));
    return { buffer, lastModified: member.passUpdatedAt };
  }

  // ── Till ─────────────────────────────────────────────────────────────────

  /** Whether the till should offer the loyalty button at all, and the join link. */
  async tillStatus(tenantId: string, locationId: string) {
    await this.assertLocation(tenantId, locationId);
    const card = await this.loadCard(locationId);
    const location = await this.prisma.location.findUnique({
      where: { id: locationId },
      select: { onlineOrderingSlug: true, slug: true },
    });
    return {
      enabled: !!card && card.isActive && card.walkInEnabled,
      stampIcon: card?.stampIcon ?? null,
      stampsRequired: card?.stampsRequired ?? 6,
      rewardLabel: card ? this.rewardLabelOf(card) : null,
      joinUrl: `${this.webUrl()}/loyalty/join/${location?.onlineOrderingSlug ?? location?.slug ?? locationId}`,
    };
  }

  /** Find a card by what was scanned or typed: the QR, the card number, or a phone. */
  async lookup(tenantId: string, locationId: string, query: string) {
    await this.assertLocation(tenantId, locationId);
    const card = await this.loadCard(locationId);
    if (!card) throw new NotFoundException("This shop has no loyalty card set up.");

    const code = parseMemberCode(query);
    let member = code
      ? await this.prisma.loyaltyMember.findUnique({ where: { code }, select: MEMBER_LOOKUP_SELECT })
      : null;
    if (!member && query.includes("@")) {
      const email = normaliseEmail(query);
      if (email) member = await this.findByContact(card.id, { email });
    }
    if (!member && !query.includes("@")) {
      const phone = toE164(query);
      if (phone) member = await this.findByContact(card.id, { phone });
    }
    if (!member || member.tenantId !== tenantId) throw new NotFoundException("No loyalty card found.");
    if (member.cardId !== card.id) {
      const other = await this.prisma.location.findUnique({ where: { id: member.locationId }, select: { name: true } });
      throw new BadRequestException(`That card belongs to ${other?.name?.trim() ?? "another shop"}.`);
    }
    return this.tillView(member, card);
  }

  /** Staff sign a customer up at the counter. The card link goes by email. */
  async enrol(
    tenantId: string,
    locationId: string,
    dto: { email?: string; phone?: string; firstName?: string; marketingConsent?: boolean },
  ) {
    await this.assertLocation(tenantId, locationId);
    const card = await this.loadCard(locationId);
    if (!card || !card.isActive || !card.walkInEnabled) {
      throw new BadRequestException("Switch on the walk-in loyalty card in Marketing first.");
    }
    const contact = this.contactFrom(dto, "Enter the customer's email address.");
    const firstName = this.cleanName(dto.firstName);

    const found = await this.findByContact(card.id, contact);
    const member = found ?? (await this.createMember(card, { ...contact, firstName, source: "TILL" }));
    if (!found && dto.marketingConsent) this.emitConsent(card, contact, firstName);
    const sent = await this.sendCardLink(member, card, found ? "resend" : "welcome");
    return {
      existing: !!found,
      sent,
      via: member.email ? ("email" as const) : ("sms" as const),
      // A brand-new card can be shown on the till screen for the customer, who
      // is standing there, to scan. An existing one never is — see join().
      cardUrl: found ? null : `${this.webUrl()}/loyalty/card/${member.publicToken}`,
      member: await this.tillView(member, card),
    };
  }

  /**
   * The card link for the till screen, so a customer whose text never
   * arrived can scan it there and add the card to a new phone. Staff have the
   * customer in front of them; that is the check.
   */
  async cardLink(tenantId: string, memberId: string) {
    const member = await this.prisma.loyaltyMember.findFirst({
      where: { id: memberId, tenantId },
      select: { publicToken: true },
    });
    if (!member) throw new NotFoundException("No loyalty card found.");
    return { cardUrl: `${this.webUrl()}/loyalty/card/${member.publicToken}` };
  }

  async resendLink(tenantId: string, memberId: string) {
    const member = await this.prisma.loyaltyMember.findFirst({
      where: { id: memberId, tenantId },
      select: MEMBER_LOOKUP_SELECT,
    });
    if (!member) throw new NotFoundException("No loyalty card found.");
    const card = await this.loadCard(member.locationId);
    if (!card) throw new NotFoundException("No loyalty card found.");
    const sent = await this.sendCardLink(member, card, "resend");
    if (!sent) {
      throw new BadRequestException(
        member.email
          ? "The email could not be sent. Show the card QR on the till instead."
          : "The text could not be sent. Show the card QR on the till instead.",
      );
    }
    return { sent, via: member.email ? "email" : "sms" };
  }

  // ── Orders ───────────────────────────────────────────────────────────────

  /**
   * Called by OrdersService BEFORE the order is written. A reward that has
   * gone (spent on the other till a moment ago, or expired) must fail the
   * sale while the customer is still there, not quietly give it away twice.
   * A retry of the same order (same idempotency key) is not a second spend.
   */
  async assertRewardSpendable(
    tenantId: string,
    locationId: string,
    memberId: string,
    rewardId: string,
    idempotencyKey?: string,
  ) {
    const reward = await this.prisma.loyaltyReward.findFirst({
      where: { id: rewardId, memberId, locationId, tenantId },
      select: { claimedAt: true, claimedOrderId: true, expiresAt: true },
    });
    if (!reward) throw new BadRequestException("That loyalty reward isn't on this card.");
    if (reward.claimedAt) {
      if (idempotencyKey && reward.claimedOrderId) {
        const prior = await this.prisma.order.findUnique({
          where: { id: reward.claimedOrderId },
          select: { idempotencyKey: true },
        });
        if (prior?.idempotencyKey === idempotencyKey) return;
      }
      throw new BadRequestException("That loyalty reward has already been used. Remove it from the basket.");
    }
    if (reward.expiresAt && reward.expiresAt <= new Date()) {
      throw new BadRequestException("That loyalty reward has expired. Remove it from the basket.");
    }
  }

  /** Called by OrdersService AFTER the order is written. Never throws. */
  async attachOrder(orderId: string, tenantId: string, memberId: string, rewardId?: string | null) {
    try {
      const member = await this.prisma.loyaltyMember.findFirst({
        where: { id: memberId, tenantId },
        select: { id: true },
      });
      if (!member) return;
      await this.prisma.order.update({ where: { id: orderId }, data: { loyaltyMemberId: member.id } });
      if (rewardId) {
        await this.prisma.loyaltyReward.updateMany({
          where: { id: rewardId, memberId: member.id, claimedAt: null },
          data: { claimedAt: new Date(), claimedOrderId: orderId },
        });
      }
      await this.loyalty.awardForOrder(orderId);
      // awardForOrder announces stamps; a reward spent with no new stamp
      // still changes the pass.
      this.events.emit(MEMBER_CHANGED, { memberId: member.id });
    } catch (err) {
      this.logger.warn(`Walk-in loyalty for order ${orderId} failed: ${(err as Error).message}`);
    }
  }

  // ── Dashboard ────────────────────────────────────────────────────────────

  async overview(tenantId: string, locationId: string) {
    await this.assertLocation(tenantId, locationId);
    const location = await this.prisma.location.findUnique({
      where: { id: locationId },
      select: { id: true, name: true, logoUrl: true, onlineOrderingSlug: true, slug: true, brand: { select: { logoUrl: true } } },
    });
    const card = await this.loadCard(locationId);
    const web = this.webUrl();
    const joinUrl = `${web}/loyalty/join/${location?.onlineOrderingSlug ?? location?.slug ?? locationId}`;
    // What the pass shows when the operator leaves name/logo empty.
    const defaults = {
      defaultTitle: location?.name?.trim() ?? "",
      defaultLogoUrl: location?.logoUrl ?? location?.brand?.logoUrl ?? null,
    };
    if (!card) {
      return { joinUrl, ...defaults, members: 0, joinedThisWeek: 0, stampsThisMonth: 0, rewardsClaimed: 0, walletReady: this.walletReady() };
    }
    const weekAgo = new Date(Date.now() - 7 * 86_400_000);
    const monthAgo = new Date(Date.now() - 30 * 86_400_000);
    const [members, joinedThisWeek, stampsThisMonth, rewardsClaimed] = await Promise.all([
      this.prisma.loyaltyMember.count({ where: { cardId: card.id } }),
      this.prisma.loyaltyMember.count({ where: { cardId: card.id, createdAt: { gte: weekAgo } } }),
      this.prisma.loyaltyStamp.count({ where: { cardId: card.id, memberId: { not: null }, createdAt: { gte: monthAgo } } }),
      this.prisma.loyaltyReward.count({ where: { cardId: card.id, memberId: { not: null }, claimedAt: { not: null } } }),
    ]);
    return { joinUrl, ...defaults, members, joinedThisWeek, stampsThisMonth, rewardsClaimed, walletReady: this.walletReady() };
  }

  // ── Keeping passes current ───────────────────────────────────────────────

  @OnEvent(MEMBER_CHANGED)
  async onMemberChanged(payload: { memberId?: string }) {
    if (!payload.memberId) return;
    try {
      const member = await this.prisma.loyaltyMember.update({
        where: { id: payload.memberId },
        data: { passUpdatedAt: new Date() },
        select: { ...MEMBER_LOOKUP_SELECT, passDevices: { select: { pushToken: true } } },
      });
      const card = await this.loadCard(member.locationId);
      if (!card) return;
      const tokens = member.passDevices.map((d) => d.pushToken);
      const dead = await this.apple.push(tokens);
      if (dead.length) {
        await this.prisma.loyaltyPassDevice.deleteMany({ where: { pushToken: { in: dead } } });
      }
      if (member.googleObjectAt) await this.google.updateObject(await this.view(member, card));
    } catch (err) {
      this.logger.warn(`Wallet pass refresh for ${payload.memberId} failed: ${(err as Error).message}`);
    }
  }

  /** The shop changed the card's look or reward: every pass follows. */
  @OnEvent("loyalty.card_changed")
  async onCardChanged(payload: { locationId?: string }) {
    if (!payload.locationId) return;
    try {
      const card = await this.loadCard(payload.locationId);
      if (!card) return;
      await this.prisma.loyaltyMember.updateMany({ where: { cardId: card.id }, data: { passUpdatedAt: new Date() } });
      const devices = await this.prisma.loyaltyPassDevice.findMany({
        where: { member: { cardId: card.id } },
        select: { pushToken: true },
      });
      const dead = await this.apple.push(devices.map((d) => d.pushToken));
      if (dead.length) await this.prisma.loyaltyPassDevice.deleteMany({ where: { pushToken: { in: dead } } });

      const sample = await this.prisma.loyaltyMember.findFirst({ where: { cardId: card.id }, select: MEMBER_LOOKUP_SELECT });
      if (sample && this.google.configured()) {
        await this.google.updateClass(await this.view(sample, card));
        const saved = await this.prisma.loyaltyMember.findMany({
          where: { cardId: card.id, googleObjectAt: { not: null } },
          select: MEMBER_LOOKUP_SELECT,
          take: 500,
        });
        for (const m of saved) await this.google.updateObject(await this.view(m, card));
      }
    } catch (err) {
      this.logger.warn(`Wallet refresh for card at ${payload.locationId} failed: ${(err as Error).message}`);
    }
  }

  // ── Art (public, no ids) ─────────────────────────────────────────────────

  async iconForCard(cardId: string): Promise<{ logoUrl: string | null; color: string; stampIcon: string | null }> {
    const card = await this.prisma.loyaltyCard.findUnique({ where: { id: cardId }, select: { locationId: true } });
    if (!card) throw new NotFoundException();
    const full = await this.loadCard(card.locationId);
    if (!full) throw new NotFoundException();
    return { logoUrl: this.logoOf(full), color: safeColor(full.cardColor), stampIcon: full.stampIcon };
  }

  // ── Internals ────────────────────────────────────────────────────────────

  async loadCard(locationId: string) {
    return this.prisma.loyaltyCard.findUnique({
      where: { locationId },
      include: {
        rewardItem: { select: { id: true, name: true } },
        location: {
          select: {
            id: true,
            name: true,
            logoUrl: true,
            currency: true,
            brand: { select: { logoUrl: true } },
          },
        },
      },
    });
  }

  private async view(
    member: { id: string; cardId: string; code: string; publicToken: string; firstName: string | null; passUpdatedAt: Date },
    card: CardWithShop,
  ): Promise<PassView> {
    const [stamps, rewards] = await Promise.all([
      this.prisma.loyaltyStamp.count({ where: { cardId: card.id, memberId: member.id } }),
      this.liveRewards(member.id, card.locationId),
    ]);
    const color = safeColor(card.cardColor);
    const api = this.apiUrl();
    return {
      memberId: member.id,
      cardId: card.id,
      code: member.code,
      publicToken: member.publicToken,
      firstName: member.firstName,
      title: this.titleOf(card),
      color,
      stampIcon: card.stampIcon,
      logoUrl: this.logoOf(card),
      stamps: stamps % card.stampsRequired,
      stampsRequired: card.stampsRequired,
      rewardsReady: rewards.length,
      rewardLabel: this.rewardLabelOf(card),
      earnRule: this.earnRule(card),
      expiryNote: this.expiryNote(card),
      cardUrl: `${this.webUrl()}/loyalty/card/${member.publicToken}`,
      stripUrl: `${api}/api/v1/loyalty/walk-in/art/strip.png?s=${stamps % card.stampsRequired}&of=${card.stampsRequired}&c=${color.slice(1)}&i=${encodeURIComponent(card.stampIcon ?? "coffee")}`,
      iconUrl: `${api}/api/v1/loyalty/walk-in/art/icon/${card.id}.png?v=${card.updatedAt.getTime()}`,
      updatedAt: member.passUpdatedAt,
    };
  }

  private async tillView(
    member: {
      id: string;
      code: string;
      phone: string | null;
      email: string | null;
      firstName: string | null;
      cardId: string;
      locationId: string;
    },
    card: CardWithShop,
  ) {
    const [stamps, rewards] = await Promise.all([
      this.prisma.loyaltyStamp.count({ where: { cardId: card.id, memberId: member.id } }),
      this.liveRewards(member.id, card.locationId),
    ]);
    const items = await this.prisma.menuItem.findMany({
      where: { id: { in: rewards.map((r) => r.rewardItemId).filter((x): x is string => !!x) } },
      select: { id: true, name: true },
    });
    const itemName = new Map(items.map((i) => [i.id, i.name]));
    return {
      id: member.id,
      code: member.code,
      firstName: member.firstName,
      // Enough for staff to confirm "is this you?", not enough to harvest.
      contactHint: contactHint(member),
      stamps: stamps % card.stampsRequired,
      stampsRequired: card.stampsRequired,
      stampIcon: card.stampIcon,
      lifetimeStamps: stamps,
      minimumSpend: card.minimumSpend != null ? Number(card.minimumSpend) : null,
      rewardLabel: this.rewardLabelOf(card),
      cardActive: card.isActive && card.walkInEnabled,
      rewards: rewards.map((r) => ({
        id: r.id,
        label: r.label,
        rewardItemId: r.rewardItemId,
        rewardItemName: r.rewardItemId ? (itemName.get(r.rewardItemId) ?? null) : null,
        amountOff: r.amountOff != null ? Number(r.amountOff) : null,
        expiresAt: r.expiresAt,
      })),
    };
  }

  private liveRewards(memberId: string, locationId: string) {
    return this.prisma.loyaltyReward.findMany({
      where: {
        memberId,
        locationId,
        claimedAt: null,
        OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
      },
      orderBy: { earnedAt: "asc" },
    });
  }

  private async createMember(
    card: CardWithShop,
    data: (Contact | { customerAccountId: string }) & {
      firstName: string | null;
      source: "SELF" | "TILL" | "ONLINE";
      customerAccountId?: string;
    },
  ) {
    // A code collision is ~1 in 650 billion; retry rather than reason about it.
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        return await this.prisma.loyaltyMember.create({
          data: {
            tenantId: card.tenantId,
            cardId: card.id,
            locationId: card.locationId,
            code: newMemberCode(),
            publicToken: newPublicToken(),
            email: "email" in data ? data.email : null,
            phone: "phone" in data ? data.phone : null,
            customerAccountId: data.customerAccountId ?? null,
            firstName: data.firstName,
            source: data.source,
          },
          select: MEMBER_LOOKUP_SELECT,
        });
      } catch (err) {
        if ((err as { code?: string; meta?: { target?: unknown } }).code !== "P2002") throw err;
        // Same customer joined twice at once: hand back the one that won.
        const raced =
          "email" in data || "phone" in data
            ? await this.findByContact(card.id, data as Contact)
            : await this.prisma.loyaltyMember.findUnique({
                where: { cardId_customerAccountId: { cardId: card.id, customerAccountId: data.customerAccountId! } },
                select: MEMBER_LOOKUP_SELECT,
              });
        if (raced) return raced;
      }
    }
    throw new Error("Could not allocate a loyalty card number");
  }

  private contactFrom(dto: { email?: string; phone?: string }, missing: string): Contact {
    if (dto.email !== undefined && String(dto.email).trim() !== "") {
      const email = normaliseEmail(dto.email);
      if (!email) throw new BadRequestException("Enter a valid email address.");
      return { email };
    }
    const phone = toE164(dto.phone);
    if (phone) return { phone };
    throw new BadRequestException(missing);
  }

  private findByContact(cardId: string, contact: Contact) {
    return this.prisma.loyaltyMember.findUnique({
      where:
        "email" in contact
          ? { cardId_email: { cardId, email: contact.email } }
          : { cardId_phone: { cardId, phone: contact.phone } },
      select: MEMBER_LOOKUP_SELECT,
    });
  }

  /**
   * Send the card link — by email when we have one (free), by text for older
   * phone-only members. False (never a throw) when it could not be sent.
   */
  private async sendCardLink(member: Reachable, card: CardWithShop, kind: "welcome" | "resend"): Promise<boolean> {
    const url = `${this.webUrl()}/loyalty/card/${member.publicToken}`;
    try {
      if (member.email) {
        const mail = cardEmail({
          kind,
          title: this.titleOf(card),
          color: safeColor(card.cardColor),
          logoUrl: this.logoOf(card),
          firstName: member.firstName,
          cardUrl: url,
          stampsRequired: card.stampsRequired,
          rewardLabel: this.rewardLabelOf(card),
          earnRule: this.earnRule(card),
        });
        await this.mail.send({ to: member.email, fromName: this.titleOf(card), ...mail });
        return true;
      }
      if (!member.phone || !this.sms.isConfigured()) return false;
      const hello = member.firstName ? `Hi ${member.firstName}, ` : "";
      await this.sms.send({
        tenantId: card.tenantId,
        to: member.phone,
        body: `${hello}here is your ${this.titleOf(card)} loyalty card: ${url}`,
        purpose: "OTHER",
        locationId: card.locationId,
      });
      return true;
    } catch (err) {
      this.logger.warn(`Loyalty card link failed: ${(err as Error).message}`);
      return false;
    }
  }

  private hashCode(memberId: string, code: string): string {
    return createHash("sha256").update(`${memberId}:${code}`).digest("hex");
  }

  /** A fresh 6-digit code (plus the card link, so either works). */
  private async sendVerifyCode(member: Reachable, card: CardWithShop): Promise<boolean> {
    if (!member.email && (!member.phone || !this.sms.isConfigured())) return false;
    const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
    await this.prisma.loyaltyMember.update({
      where: { id: member.id },
      data: {
        verifyCodeHash: this.hashCode(member.id, code),
        verifyExpiresAt: new Date(Date.now() + 10 * 60_000),
        verifyAttempts: 0,
      },
    });
    const url = `${this.webUrl()}/loyalty/card/${member.publicToken}`;
    try {
      if (member.email) {
        const mail = codeEmail({
          title: this.titleOf(card),
          color: safeColor(card.cardColor),
          logoUrl: this.logoOf(card),
          firstName: member.firstName,
          code,
          cardUrl: url,
        });
        await this.mail.send({ to: member.email, fromName: this.titleOf(card), ...mail });
      } else {
        await this.sms.send({
          tenantId: card.tenantId,
          to: member.phone!,
          body: `${code} is your ${this.titleOf(card)} loyalty card code. Or open your card here: ${url}`,
          purpose: "OTHER",
          locationId: card.locationId,
        });
      }
      return true;
    } catch (err) {
      this.logger.warn(`Loyalty verify code failed: ${(err as Error).message}`);
      return false;
    }
  }

  private emitConsent(card: CardWithShop, contact: Contact, firstName: string | null) {
    if ("email" in contact) {
      this.events.emit("email-marketing.consent", {
        tenantId: card.tenantId,
        locationId: card.locationId,
        email: contact.email,
        firstName,
        source: "LOYALTY",
      });
      return;
    }
    this.events.emit("marketing.consent", {
      tenantId: card.tenantId,
      locationId: card.locationId,
      phone: contact.phone,
      firstName,
      source: "LOYALTY",
      consent: true,
    });
  }

  private async memberByToken(token: string) {
    if (!token || token.length < 20) throw new NotFoundException("Card not found");
    const member = await this.prisma.loyaltyMember.findUnique({
      where: { publicToken: token },
      select: MEMBER_LOOKUP_SELECT,
    });
    if (!member) throw new NotFoundException("Card not found");
    const card = await this.loadCard(member.locationId);
    if (!card) throw new NotFoundException("Card not found");
    return { member, card };
  }

  private async passAuth(passTypeId: string, serial: string, auth: string | undefined) {
    const token = (auth ?? "").replace(/^ApplePass\s+/i, "").trim();
    if (!token || passTypeId !== this.apple.passTypeId) throw new UnauthorizedException();
    const member = await this.prisma.loyaltyMember.findUnique({ where: { id: serial }, select: MEMBER_LOOKUP_SELECT });
    if (!member || member.publicToken !== token) throw new UnauthorizedException();
    return member;
  }

  private async resolveShop(shop: string) {
    const location = await this.prisma.location.findFirst({
      where: { deletedAt: null, OR: [{ onlineOrderingSlug: shop }, { slug: shop }, { id: shop }] },
      select: { id: true, name: true },
    });
    if (!location) throw new NotFoundException("Shop not found");
    return location;
  }

  private async assertLocation(tenantId: string, locationId: string) {
    const found = await this.prisma.location.findFirst({
      where: { id: locationId, deletedAt: null, brand: { tenantId } },
      select: { id: true },
    });
    if (!found) throw new ForbiddenException("Location not found");
  }

  private titleOf(card: CardWithShop): string {
    return (card.cardTitle?.trim() || card.location.name.trim() || "Loyalty card").slice(0, 40);
  }

  private logoOf(card: CardWithShop): string | null {
    return card.cardLogoUrl || card.location.logoUrl || card.location.brand.logoUrl || null;
  }

  private rewardLabelOf(card: CardWithShop): string {
    return card.rewardLabel?.trim() || card.rewardItem?.name || "Free item";
  }

  private earnRule(card: CardWithShop): string {
    const reward = this.rewardLabelOf(card).toLowerCase();
    const spend =
      card.minimumSpend != null && Number(card.minimumSpend) > 0
        ? ` over ${new Intl.NumberFormat("en-GB", { style: "currency", currency: card.location.currency || "GBP" }).format(Number(card.minimumSpend))}`
        : "";
    return `Every order${spend} earns a stamp. Collect ${card.stampsRequired} for ${reward}.`;
  }

  private expiryNote(card: CardWithShop): string | null {
    return card.rewardExpiryDays ? `Rewards can be used for ${card.rewardExpiryDays} days after you earn them.` : null;
  }

  private cleanName(raw: string | undefined): string | null {
    const v = (raw ?? "").replace(/\s+/g, " ").trim().slice(0, 40);
    return v || null;
  }

  private walletReady() {
    return {
      apple: this.apple.configured(),
      google: this.google.configured(),
      // Card links and codes go by email; without a Resend key they are only logged.
      email: !!process.env.RESEND_API_KEY,
    };
  }

  private webUrl(): string {
    return (process.env.WEB_URL ?? "https://www.orderhubsolutions.com").replace(/\/+$/, "");
  }

  private apiUrl(): string {
    return (process.env.API_URL ?? "http://localhost:4000").replace(/\/+$/, "");
  }
}
