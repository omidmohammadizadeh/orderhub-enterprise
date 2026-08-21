import { BadRequestException, Injectable, Logger, NotFoundException } from "@nestjs/common";
import { OnEvent } from "@nestjs/event-emitter";
import { PrismaService } from "../../infrastructure/database/prisma.service";
import { SmsService } from "../sms/sms.service";
import { WalletService } from "../wallet/wallet.service";
import { toE164 } from "../sms/phone";

// The unsubscribe footer PECR requires on marketing texts. Appended to every
// send (unless the body already contains a STOP instruction). Its cost is
// included in every preview so the operator sees the true segment count.
const STOP_FOOTER = "Reply STOP to opt out";

// STOP-style keywords that flip a contact to OPTED_OUT when they reply.
const STOP_WORDS = ["STOP", "STOPALL", "UNSUBSCRIBE", "CANCEL", "END", "QUIT", "OPTOUT"];
const START_WORDS = ["START", "UNSTOP", "YES", "OPTIN"];

export interface ImportRow {
  phone: string;
  firstName?: string;
  lastName?: string;
  name?: string;
  email?: string;
}

export interface ImportReport {
  added: number;
  updated: number;
  duplicatesInFile: number;
  invalid: number;
  suppressed: number; // matched an opted-out contact — left untouched
  total: number;
}

@Injectable()
export class MarketingSmsService {
  private readonly logger = new Logger(MarketingSmsService.name);

  // Channels a contact can be sourced from — the OrderSource enum. Kept as a
  // plain list so new channels (future marketplaces) show up automatically
  // once orders carry that source.
  static readonly CHANNELS = [
    "POS",
    "ONLINE",
    "WHATSAPP",
    "UBER_EATS",
    "DELIVEROO",
    "JUST_EAT",
    "HUBRISE",
    "TALABAT",
    "DOORDASH",
    "GRUBHUB",
    "CAREEM",
    "DIRECT",
  ];

  constructor(
    private readonly prisma: PrismaService,
    private readonly sms: SmsService,
    private readonly wallet: WalletService,
  ) {}

  private db(): any {
    return this.prisma as any;
  }

  // ── Phone normalisation ────────────────────────────────────────────────────

  /**
   * Normalise a raw phone string to E.164 (UK default). Returns null if it
   * can't form a plausible number — the caller counts those as "invalid". E.164
   * is the dedupe key, so "07700 900123", "+447700900123" and "447700900123"
   * all collapse to one contact.
   */
  normalizePhone(raw: string | null | undefined): string | null {
    // Delegates to the shared rule in sms/phone.ts. This method used to carry
    // its own copy, which meant marketing and payment-link sends could disagree
    // about what the same number normalises to — the kind of drift where one
    // channel texts a customer fine and the other rejects them.
    return toE164(raw);
  }

  // ── Contacts ────────────────────────────────────────────────────────────────

  /**
   * Capture SMS-marketing consent from a placed order (POS or online storefront
   * checkbox). Ticked → the contact is opted IN; explicitly unticked → opted
   * OUT (and stored so a later import can't sweep them back in). Best-effort:
   * never disrupts order placement. Fired via the "marketing.consent" event so
   * the orders/ordering modules stay decoupled from this one.
   */
  @OnEvent("marketing.consent")
  async onOrderConsent(ev: {
    tenantId: string;
    locationId?: string | null;
    phone?: string | null;
    firstName?: string | null;
    source?: string | null;
    consent: boolean;
  }): Promise<void> {
    try {
      const phone = this.normalizePhone(ev.phone ?? "");
      if (!phone) return;
      if (ev.consent) {
        await this.upsertContact({
          tenantId: ev.tenantId,
          locationId: ev.locationId ?? null,
          phone,
          firstName: ev.firstName ?? null,
          source: ev.source ?? null,
          consentStatus: "OPTED_IN",
          consentSource: `order:${ev.source ?? "POS"}`,
        });
      } else {
        // Explicit decline — opt out (idempotent), storing a suppressed row so
        // a future import never re-adds them as opted-in.
        const existing = await this.db().marketingContact.findFirst({
          where: { tenantId: ev.tenantId, phone },
          select: { id: true },
        });
        if (existing) {
          await this.db().marketingContact.update({
            where: { id: existing.id },
            data: {
              consentStatus: "OPTED_OUT",
              unsubscribedAt: new Date(),
              consentSource: "order:declined",
            },
          });
        } else {
          await this.db().marketingContact.create({
            data: {
              tenantId: ev.tenantId,
              locationId: ev.locationId ?? null,
              phone,
              firstName: ev.firstName ?? null,
              source: ev.source ?? null,
              consentStatus: "OPTED_OUT",
              consentSource: "order:declined",
              unsubscribedAt: new Date(),
            },
          });
        }
      }
    } catch (err: any) {
      this.logger.warn(`Consent capture failed: ${err?.message ?? err}`);
    }
  }

  async channelCounts(
    tenantId: string,
    locationId?: string,
  ): Promise<{ channel: string; count: number }[]> {
    // Distinct customer phones per order source — what "import from POS" etc.
    // would actually pull in. Scoped to the selected location when given.
    const rows: { orderSource: string; count: bigint }[] = locationId
      ? await this.prisma.$queryRawUnsafe(
          `SELECT "orderSource", COUNT(DISTINCT "customerPhone")::bigint AS count
           FROM "orders"
           WHERE "tenantId" = $1 AND "locationId" = $2
             AND "customerPhone" IS NOT NULL AND "customerPhone" <> ''
           GROUP BY "orderSource"`,
          tenantId,
          locationId,
        )
      : await this.prisma.$queryRawUnsafe(
          `SELECT "orderSource", COUNT(DISTINCT "customerPhone")::bigint AS count
           FROM "orders"
           WHERE "tenantId" = $1 AND "customerPhone" IS NOT NULL AND "customerPhone" <> ''
           GROUP BY "orderSource"`,
          tenantId,
        );
    const map = new Map(rows.map((r) => [r.orderSource, Number(r.count)]));
    return MarketingSmsService.CHANNELS.map((c) => ({ channel: c, count: map.get(c) ?? 0 }));
  }

  async listContacts(
    tenantId: string,
    opts: { consent?: string; source?: string; search?: string; limit?: number; locationId?: string } = {},
  ) {
    const scope: any = { tenantId };
    if (opts.locationId) scope.locationId = opts.locationId;
    const where: any = { ...scope };
    if (opts.consent) where.consentStatus = opts.consent;
    if (opts.source) where.source = opts.source;
    if (opts.search) {
      const q = opts.search.trim();
      where.OR = [
        { phone: { contains: q } },
        { firstName: { contains: q, mode: "insensitive" } },
        { lastName: { contains: q, mode: "insensitive" } },
      ];
    }
    const [items, total, optedIn] = await Promise.all([
      this.db().marketingContact.findMany({
        where,
        orderBy: { createdAt: "desc" },
        take: Math.min(opts.limit ?? 200, 1000),
      }),
      this.db().marketingContact.count({ where: scope }),
      this.db().marketingContact.count({ where: { ...scope, consentStatus: "OPTED_IN" } }),
    ]);
    return { items, total, optedIn };
  }

  /**
   * Upsert one contact. Opted-out contacts are sacred — never modified or
   * re-opted-in by an import (suppression is permanent). Returns what happened
   * so the caller can build a dedupe report.
   */
  private async upsertContact(args: {
    tenantId: string;
    locationId?: string | null;
    phone: string;
    firstName?: string | null;
    lastName?: string | null;
    email?: string | null;
    source?: string | null;
    customerId?: string | null;
    consentStatus: string; // desired status for NEW rows
    consentSource?: string | null;
    createdBy?: string | null;
  }): Promise<"added" | "updated" | "suppressed"> {
    // findFirst (not findUnique) so nullable locationId is handled cleanly.
    const existing = await this.db().marketingContact.findFirst({
      where: {
        tenantId: args.tenantId,
        phone: args.phone,
        locationId: args.locationId ?? null,
      },
    });

    if (existing) {
      if (existing.consentStatus === "OPTED_OUT") return "suppressed";
      await this.db().marketingContact.update({
        where: { id: existing.id },
        data: {
          firstName: existing.firstName ?? args.firstName ?? null,
          lastName: existing.lastName ?? args.lastName ?? null,
          email: existing.email ?? args.email ?? null,
          source: existing.source ?? args.source ?? null,
          customerId: existing.customerId ?? args.customerId ?? null,
          // Only ever upgrade UNKNOWN → OPTED_IN, never downgrade.
          ...(existing.consentStatus === "UNKNOWN" && args.consentStatus === "OPTED_IN"
            ? { consentStatus: "OPTED_IN", consentSource: args.consentSource, consentAt: new Date() }
            : {}),
        },
      });
      return "updated";
    }

    await this.db().marketingContact.create({
      data: {
        tenantId: args.tenantId,
        locationId: args.locationId ?? null,
        phone: args.phone,
        firstName: args.firstName ?? null,
        lastName: args.lastName ?? null,
        email: args.email ?? null,
        source: args.source ?? null,
        customerId: args.customerId ?? null,
        consentStatus: args.consentStatus,
        consentSource: args.consentSource ?? null,
        consentAt: args.consentStatus === "OPTED_IN" ? new Date() : null,
        createdBy: args.createdBy ?? null,
      },
    });
    return "added";
  }

  /**
   * Import contacts from the CRM by channel. Consent honours each customer's
   * marketingConsent flag: opted-in customers become OPTED_IN, the rest come in
   * as UNKNOWN (never auto-opted-in). consentedOnly skips the UNKNOWNs entirely.
   */
  async importFromCustomers(
    tenantId: string,
    args: { sources: string[]; consentedOnly?: boolean; locationId?: string; createdBy?: string },
  ): Promise<ImportReport> {
    const sources = (args.sources ?? []).filter((s) =>
      MarketingSmsService.CHANNELS.includes(s),
    );
    if (!sources.length) throw new BadRequestException("Pick at least one channel to import from.");

    // Only pull orders from the selected location so a site markets to its own
    // customers. Imported contacts are homed to that location too.
    const orderWhere: any = { tenantId, orderSource: { in: sources }, customerPhone: { not: null } };
    if (args.locationId) orderWhere.locationId = args.locationId;

    const orders = await this.db().order.findMany({
      where: orderWhere,
      select: {
        customerPhone: true, customerName: true, customerId: true,
        orderSource: true, locationId: true,
      },
      distinct: ["customerPhone"],
      take: 50_000,
    });

    // Enrich consent + names from the Customer table.
    const customerIds = orders.map((o: any) => o.customerId).filter(Boolean);
    const customers = customerIds.length
      ? await this.db().customer.findMany({
          where: { id: { in: customerIds } },
          select: { id: true, marketingConsent: true, firstName: true, lastName: true },
        })
      : [];
    const custById = new Map(customers.map((c: any) => [c.id, c]));

    const report: ImportReport = {
      added: 0, updated: 0, duplicatesInFile: 0, invalid: 0, suppressed: 0, total: orders.length,
    };
    const seen = new Set<string>();

    for (const o of orders) {
      const phone = this.normalizePhone(o.customerPhone);
      if (!phone) { report.invalid++; continue; }
      if (seen.has(phone)) { report.duplicatesInFile++; continue; }
      seen.add(phone);

      const cust: any = o.customerId ? custById.get(o.customerId) : null;

      const [firstName, lastName] = this.splitName(o.customerName, cust);
      // Import opts every contact IN (the operator asserts consent when they
      // click Import). upsertContact still never re-opts-in a contact who
      // previously replied STOP (OPTED_OUT stays suppressed), so this is safe.
      const res = await this.upsertContact({
        tenantId,
        locationId: args.locationId ?? o.locationId ?? null,
        phone,
        firstName,
        lastName,
        source: o.orderSource,
        customerId: o.customerId ?? null,
        consentStatus: "OPTED_IN",
        consentSource: `import:${o.orderSource}`,
        createdBy: args.createdBy,
      });
      report[res === "added" ? "added" : res === "updated" ? "updated" : "suppressed"]++;
    }
    return report;
  }

  private splitName(customerName?: string | null, cust?: any): [string | null, string | null] {
    if (cust?.firstName || cust?.lastName) return [cust.firstName ?? null, cust.lastName ?? null];
    const n = (customerName ?? "").trim();
    if (!n) return [null, null];
    const parts = n.split(/\s+/);
    return [parts[0] ?? null, parts.slice(1).join(" ") || null];
  }

  /**
   * Import a parsed list of rows (from CSV / Excel / Google Sheet / paste). The
   * operator asserts consent when uploading their own list → OPTED_IN, else
   * UNKNOWN. Dedupes within the file and against existing contacts.
   */
  async importRows(
    tenantId: string,
    rows: ImportRow[],
    args: { source?: string; assertConsent: boolean; locationId?: string; createdBy?: string },
  ): Promise<ImportReport> {
    if (!Array.isArray(rows) || !rows.length) {
      throw new BadRequestException("No rows to import.");
    }
    if (rows.length > 20_000) {
      throw new BadRequestException("That's a very large list — please split it into files of 20,000 or fewer.");
    }
    const report: ImportReport = {
      added: 0, updated: 0, duplicatesInFile: 0, invalid: 0, suppressed: 0, total: rows.length,
    };
    const seen = new Set<string>();
    for (const r of rows) {
      const phone = this.normalizePhone(r.phone);
      if (!phone) { report.invalid++; continue; }
      if (seen.has(phone)) { report.duplicatesInFile++; continue; }
      seen.add(phone);

      let firstName = r.firstName ?? null;
      let lastName = r.lastName ?? null;
      if (!firstName && r.name) [firstName, lastName] = this.splitName(r.name);

      const res = await this.upsertContact({
        tenantId,
        locationId: args.locationId ?? null,
        phone,
        firstName,
        lastName,
        email: r.email ?? null,
        source: args.source ?? "IMPORT",
        consentStatus: args.assertConsent ? "OPTED_IN" : "UNKNOWN",
        consentSource: args.assertConsent ? "import:asserted" : null,
        createdBy: args.createdBy,
      });
      report[res === "added" ? "added" : res === "updated" ? "updated" : "suppressed"]++;
    }
    return report;
  }

  async addManual(
    tenantId: string,
    args: { phone: string; firstName?: string; lastName?: string; locationId?: string; createdBy?: string },
  ) {
    const phone = this.normalizePhone(args.phone);
    if (!phone) throw new BadRequestException("That doesn't look like a valid phone number.");
    await this.upsertContact({
      tenantId, locationId: args.locationId ?? null, phone,
      firstName: args.firstName, lastName: args.lastName,
      source: "MANUAL", consentStatus: "OPTED_IN", consentSource: "manual", createdBy: args.createdBy,
    });
    return { ok: true, phone };
  }

  async setConsent(tenantId: string, contactId: string, status: "OPTED_IN" | "OPTED_OUT") {
    const contact = await this.db().marketingContact.findFirst({ where: { id: contactId, tenantId } });
    if (!contact) throw new NotFoundException("Contact not found");
    await this.db().marketingContact.update({
      where: { id: contactId },
      data: {
        consentStatus: status,
        consentSource: "manual",
        consentAt: status === "OPTED_IN" ? new Date() : contact.consentAt,
        unsubscribedAt: status === "OPTED_OUT" ? new Date() : null,
      },
    });
    return { ok: true };
  }

  /** Opt out by phone — used by the inbound STOP webhook. Idempotent. */
  async optOutByPhone(tenantId: string | null, rawPhone: string, reason = "sms_stop") {
    const phone = this.normalizePhone(rawPhone);
    if (!phone) return;
    const where: any = { phone };
    if (tenantId) where.tenantId = tenantId;
    await this.db().marketingContact.updateMany({
      where,
      data: { consentStatus: "OPTED_OUT", unsubscribedAt: new Date(), consentSource: reason },
    });
  }

  async optInByPhone(tenantId: string | null, rawPhone: string) {
    const phone = this.normalizePhone(rawPhone);
    if (!phone) return;
    const where: any = { phone };
    if (tenantId) where.tenantId = tenantId;
    await this.db().marketingContact.updateMany({
      where,
      data: { consentStatus: "OPTED_IN", unsubscribedAt: null, consentAt: new Date(), consentSource: "sms_start" },
    });
  }

  // ── Campaigns ────────────────────────────────────────────────────────────────

  async listCampaigns(tenantId: string, locationId?: string) {
    const where: any = { tenantId };
    if (locationId) where.locationId = locationId;
    return this.db().marketingSmsCampaign.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take: 100,
    });
  }

  async getCampaign(tenantId: string, id: string) {
    const c = await this.db().marketingSmsCampaign.findFirst({ where: { id, tenantId } });
    if (!c) throw new NotFoundException("Campaign not found");
    return c;
  }

  /** Full message text as it will be sent: header prefix + body + STOP footer. */
  composeMessage(senderHeader: string | null | undefined, body: string): string {
    const header = (senderHeader ?? "").trim();
    let msg = header ? `${header}: ${body}` : body;
    if (!/\bSTOP\b/i.test(msg)) msg = `${msg}\n${STOP_FOOTER}`;
    return msg;
  }

  private audienceWhere(tenantId: string, audience: any, locationId?: string | null): any {
    const where: any = { tenantId, consentStatus: "OPTED_IN" };
    if (locationId) where.locationId = locationId;
    const sources: string[] = audience?.sources ?? [];
    if (sources.length) where.source = { in: sources };
    const tags: string[] = audience?.tags ?? [];
    if (tags.length) where.tags = { hasSome: tags };
    return where;
  }

  /**
   * Live preview for the compose screen: how many opted-in recipients match,
   * segments per message (with header + footer + a sample name), total cost, and
   * whether the wallet covers it.
   */
  async previewAudience(
    tenantId: string,
    args: { senderHeader?: string; body: string; audience: any; locationId?: string },
  ) {
    const recipients = await this.db().marketingContact.count({
      where: this.audienceWhere(tenantId, args.audience, args.locationId),
    });
    // Segment estimate uses the composed message with a sample name substituted.
    const sample = this.personalize(this.composeMessage(args.senderHeader, args.body), {
      firstName: "there",
    });
    const summary = await this.wallet.getSummary(tenantId, args.locationId ?? null);
    const segmentsPer = this.wallet.estimateSegments(sample);
    const totalSegments = recipients * segmentsPer;
    const costMinor = totalSegments * summary.pricePerSegmentMinor;
    return {
      recipients,
      segmentsPerMessage: segmentsPer,
      totalSegments,
      costMinor,
      pricePerSegmentMinor: summary.pricePerSegmentMinor,
      balanceMinor: summary.balanceMinor,
      canAfford: summary.balanceMinor >= costMinor,
      previewText: sample,
      messageLength: sample.length,
    };
  }

  private personalize(text: string, contact: { firstName?: string | null }): string {
    const name = (contact.firstName ?? "").trim() || "there";
    return text
      .replace(/\{\{\s*(first_?name|name)\s*\}\}/gi, name)
      .replace(/\{\{\s*[^}]+\}\}/g, ""); // strip any unknown tags
  }

  async createOrUpdateCampaign(
    tenantId: string,
    args: {
      id?: string; name: string; senderHeader?: string; body: string;
      audience?: any; locationId?: string; createdBy?: string;
    },
    role?: string,
  ) {
    if (!args.body?.trim()) throw new BadRequestException("Message body is required.");
    const data: any = {
      name: args.name?.trim() || "Untitled campaign",
      senderHeader: args.senderHeader?.trim() || null,
      body: args.body,
      audience: args.audience ?? {},
    };
    if (args.id) {
      const c = await this.getCampaign(tenantId, args.id);
      // A location-scoped user can only touch campaigns for their own location.
      await this.wallet.assertLocationAccess(tenantId, c.locationId, args.createdBy, role);
      if (c.status !== "DRAFT") throw new BadRequestException("This campaign has already been sent.");
      return this.db().marketingSmsCampaign.update({ where: { id: args.id }, data });
    }
    // Prevent creating a campaign that would spend another location's credits.
    await this.wallet.assertLocationAccess(tenantId, args.locationId ?? null, args.createdBy, role);
    return this.db().marketingSmsCampaign.create({
      data: { tenantId, locationId: args.locationId ?? null, ...data, createdBy: args.createdBy ?? null },
    });
  }

  /** Send a one-off test to a single number (still billed to the wallet). */
  async testSend(
    tenantId: string,
    args: {
      phone: string;
      senderHeader?: string;
      body: string;
      userId?: string;
      locationId?: string;
    },
  ) {
    const phone = this.normalizePhone(args.phone);
    if (!phone) throw new BadRequestException("Enter a valid test number.");
    const msg = this.personalize(this.composeMessage(args.senderHeader, args.body), { firstName: "there" });
    await this.sms.send({
      tenantId,
      to: phone,
      body: msg,
      purpose: "MARKETING",
      // Bill the SAME wallet the operator funded (the selected location's),
      // not the tenant-level one — otherwise the balance check hits an empty
      // wallet and wrongly reports "balance too low".
      locationId: args.locationId ?? null,
      createdBy: args.userId,
    });
    return { ok: true };
  }

  /**
   * Send a campaign. Validates + flips to SENDING, then broadcasts in the
   * background (so the request returns fast). Per recipient: dedupe, personalise,
   * append the STOP footer, debit the wallet via SmsService. Stops early and
   * marks the rest skipped if the wallet runs dry. Opted-out contacts are never
   * included (audienceWhere filters to OPTED_IN).
   */
  async sendCampaign(tenantId: string, id: string, userId?: string, role?: string) {
    const campaign = await this.getCampaign(tenantId, id);
    // Defence in depth: block spending another location's SMS credits even if
    // a campaign somehow points at a location this user can't access.
    await this.wallet.assertLocationAccess(tenantId, campaign.locationId, userId, role);
    if (campaign.status === "SENDING") throw new BadRequestException("This campaign is already sending.");
    if (campaign.status === "SENT") throw new BadRequestException("This campaign has already been sent.");
    if (!this.sms.isConfigured()) {
      throw new BadRequestException("SMS isn't switched on for your account yet.");
    }

    const preview = await this.previewAudience(tenantId, {
      senderHeader: campaign.senderHeader,
      body: campaign.body,
      audience: campaign.audience,
      locationId: campaign.locationId ?? undefined,
    });
    if (preview.recipients === 0) {
      throw new BadRequestException("No opted-in contacts match this audience.");
    }
    if (!preview.canAfford) {
      throw new BadRequestException(
        `Your wallet needs about £${(preview.costMinor / 100).toFixed(2)} to send this (${preview.recipients} recipients). Top up and try again.`,
      );
    }

    await this.db().marketingSmsCampaign.update({
      where: { id },
      data: {
        status: "SENDING",
        startedAt: new Date(),
        recipientCount: preview.recipients,
        sentCount: 0, failedCount: 0, skippedCount: 0, segments: 0, costMinor: 0,
      },
    });

    // Broadcast in the background; the request returns immediately.
    setImmediate(() => this.runBroadcast(tenantId, id, userId).catch((err) =>
      this.logger.error(`Broadcast ${id} failed: ${err?.message ?? err}`),
    ));

    return { ok: true, recipients: preview.recipients, estimatedCostMinor: preview.costMinor };
  }

  private async runBroadcast(tenantId: string, id: string, userId?: string) {
    const campaign = await this.db().marketingSmsCampaign.findUnique({ where: { id } });
    if (!campaign) return;
    const rate = (await this.wallet.getSummary(tenantId, campaign.locationId ?? null)).pricePerSegmentMinor;

    const contacts = await this.db().marketingContact.findMany({
      where: this.audienceWhere(tenantId, campaign.audience, campaign.locationId),
      select: { id: true, phone: true, firstName: true },
    });

    let sent = 0, failed = 0, skipped = 0, segments = 0, cost = 0;
    let outOfFunds = false;

    for (const c of contacts) {
      // In-campaign dedupe via the unique [campaignId, phone] index.
      try {
        await this.db().marketingSmsRecipient.create({
          data: { campaignId: id, tenantId, contactId: c.id, phone: c.phone, status: "PENDING" },
        });
      } catch {
        skipped++;
        continue; // already queued this number for this campaign
      }

      if (outOfFunds) {
        await this.markRecipient(id, c.phone, "SKIPPED", "insufficient_balance");
        skipped++;
        continue;
      }

      const msg = this.personalize(this.composeMessage(campaign.senderHeader, campaign.body), c);
      try {
        const res = await this.sms.send({
          tenantId, to: c.phone, body: msg, purpose: "MARKETING",
          campaignId: id, locationId: campaign.locationId ?? null, createdBy: userId,
        });
        segments += res.segments;
        cost += res.segments * rate;
        sent++;
        await this.markRecipient(id, c.phone, "SENT", null, res.segments, res.sid);
        await this.db().marketingContact.update({
          where: { id: c.id }, data: { lastCampaignAt: new Date() },
        }).catch(() => null);
      } catch (err: any) {
        const message = String(err?.message ?? err);
        if (/wallet|balance|top up/i.test(message)) {
          outOfFunds = true;
          await this.markRecipient(id, c.phone, "SKIPPED", "insufficient_balance");
          skipped++;
        } else {
          failed++;
          await this.markRecipient(id, c.phone, "FAILED", message.slice(0, 300));
        }
      }

      // Periodic progress flush so the UI can poll live counts.
      if ((sent + failed + skipped) % 25 === 0) {
        await this.db().marketingSmsCampaign.update({
          where: { id }, data: { sentCount: sent, failedCount: failed, skippedCount: skipped, segments, costMinor: cost },
        }).catch(() => null);
      }
    }

    await this.db().marketingSmsCampaign.update({
      where: { id },
      data: {
        status: "SENT",
        completedAt: new Date(),
        sentCount: sent, failedCount: failed, skippedCount: skipped, segments, costMinor: cost,
      },
    });
    this.logger.log(`Campaign ${id} done: sent=${sent} failed=${failed} skipped=${skipped} cost=${cost}p`);
  }

  private async markRecipient(
    campaignId: string, phone: string, status: string, reason?: string | null,
    segments = 0, smsMessageId?: string | null,
  ) {
    await this.db().marketingSmsRecipient.updateMany({
      where: { campaignId, phone },
      data: { status, reason: reason ?? null, segments, smsMessageId: smsMessageId ?? null },
    }).catch(() => null);
  }

  // ── Inbound STOP/START ───────────────────────────────────────────────────────

  /** Handle a Twilio inbound SMS: STOP → opt out, START → opt in. */
  async handleInbound(from: string, body: string) {
    const word = (body ?? "").trim().toUpperCase().split(/\s+/)[0] ?? "";
    if (STOP_WORDS.includes(word)) {
      await this.optOutByPhone(null, from, "sms_stop");
      this.logger.log(`Inbound STOP from ${from} → opted out`);
      return { action: "opted_out" };
    }
    if (START_WORDS.includes(word)) {
      await this.optInByPhone(null, from);
      return { action: "opted_in" };
    }
    return { action: "none" };
  }
}
