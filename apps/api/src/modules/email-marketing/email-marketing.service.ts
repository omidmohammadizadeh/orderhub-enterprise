import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { OnEvent } from "@nestjs/event-emitter";
import {
  EMAIL_TEMPLATES,
  formatMoney,
  personalise,
  renderEmail,
  type EmailAudience,
  type EmailDesign,
  type EmailProduct,
} from "@orderhub/shared";
import { PrismaService } from "../../infrastructure/database/prisma.service";
import { EmailService } from "../../infrastructure/email/email.service";
import { WalletService } from "../wallet/wallet.service";
import {
  buildAudienceQuery,
  emailCostMinor,
  normaliseEmail,
  NOT_REAL_ORDER,
  ORDER_EMAIL_SQL,
} from "./email-audience";
import { makeEmailToken, readEmailToken } from "./email-tokens";

// Email marketing: restaurants emailing their own customers.
//
// THE RULES THIS FILE EXISTS TO KEEP
//
//  1. Only SUBSCRIBED contacts are ever mailed. Consent is per channel: an SMS
//     opt-in is not an email opt-in, so this audience is its own table.
//  2. A suppression is permanent. Unsubscribed, bounced and complained
//     addresses can't be brought back by an import or by the restaurant —
//     only by the customer themselves ticking the box again at checkout (and
//     never for a bounce or a spam complaint).
//  3. Marketplace customers are never imported. Uber Eats / Deliveroo / JET
//     customers belong to the marketplace, their emails are relay addresses,
//     and the partner terms forbid marketing to them.
//  4. Every send is paid before it goes: one guarded wallet debit for the
//     whole campaign, and a refund at the end for anything that didn't send.
//
// Sending itself is EmailCampaignSenderService's job (a cron sweep, so a
// redeploy mid-campaign resumes instead of losing or repeating anyone).

/** Our own channels — the only ones whose customers a shop may email. */
export const EMAIL_IMPORT_SOURCES = ["ONLINE", "POS", "DIRECT", "WHATSAPP", "VOICE"];

const TENANT_WIDE_ROLES = ["PLATFORM_ADMIN", "TENANT_OWNER"];

export interface Actor {
  tenantId: string;
  userId?: string;
  role?: string;
}

export interface EmailImportRow {
  email: string;
  firstName?: string;
  lastName?: string;
  name?: string;
}

export interface EmailImportReport {
  added: number;
  updated: number;
  duplicatesInFile: number;
  invalid: number;
  suppressed: number;
  total: number;
}

@Injectable()
export class EmailMarketingService {
  private readonly logger = new Logger(EmailMarketingService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly wallet: WalletService,
    @Optional() private readonly email?: EmailService,
  ) {}

  /** Typed on purpose: an `as any` here is how a wrong field name reaches
   *  production unnoticed. */
  db() {
    return this.prisma;
  }

  // ── Config ────────────────────────────────────────────────────────────────

  cfg<T>(key: string): T | undefined {
    return this.config?.get<T>(`app.emailMarketing.${key}`);
  }
  isEnabled(): boolean {
    return !!this.cfg<boolean>("enabled");
  }
  pricePer1000Minor(): number {
    const n = Number(this.cfg<number>("pricePer1000Minor") ?? 300);
    return Number.isFinite(n) && n >= 0 ? n : 300;
  }
  freePerMonth(): number {
    const n = Number(this.cfg<number>("freePerMonth") ?? 1000);
    return Number.isFinite(n) && n >= 0 ? n : 1000;
  }
  tokenSecret(): string {
    return String(this.cfg<string>("tokenSecret") ?? "");
  }
  fromAddress(): string | undefined {
    const f = String(this.cfg<string>("from") ?? "").trim();
    return f || undefined;
  }
  webBase(): string {
    return String(this.config?.get<string>("app.webUrl") ?? "https://www.orderhubsolutions.com").replace(
      /\/+$/,
      "",
    );
  }
  /** Public API base, through the web proxy (NEXT_PUBLIC_API_URL=/api). */
  apiBase(): string {
    return `${this.webBase()}/api/v1/email-marketing`;
  }

  // ── Access ────────────────────────────────────────────────────────────────

  /**
   * Which shops this request may see. Tenant-wide roles get null (every shop)
   * unless they picked one; location-scoped owners get their own shops and
   * nothing else — one franchisee must never see or mail another's customers.
   */
  async scope(actor: Actor, locationId?: string | null): Promise<string[] | null> {
    const allowed = await this.wallet.accessibleLocationIds(actor.tenantId, actor.userId, actor.role);
    if (locationId) {
      if (allowed && !allowed.includes(locationId)) {
        throw new ForbiddenException("You don't have access to this location.");
      }
      const loc = await this.prisma.location.findFirst({
        where: { id: locationId, brand: { tenantId: actor.tenantId } },
        select: { id: true },
      });
      if (!loc) throw new NotFoundException("Location not found");
      return [locationId];
    }
    if (allowed) {
      if (!allowed.length) throw new ForbiddenException("You don't have access to any location.");
      return allowed;
    }
    return null;
  }

  private isTenantWide(actor: Actor): boolean {
    return !actor.role || TENANT_WIDE_ROLES.includes(actor.role);
  }

  // ── Context for the dashboard ────────────────────────────────────────────

  async context(actor: Actor) {
    const rows = await this.prisma.brand.findMany({
      where: { tenantId: actor.tenantId, deletedAt: null, isActive: true },
      select: {
        id: true, name: true, logoUrl: true, primaryLocationId: true,
        locations: { select: { id: true, logoUrl: true }, take: 5 },
      },
      orderBy: { name: "asc" },
    });
    // The logo the email will actually carry (see renderContext): the brand's,
    // else its shop's — so the preview isn't missing a logo the inbox shows.
    const brands = rows.map(({ locations, ...b }) => ({
      ...b,
      logoUrl:
        b.logoUrl ??
        locations.find((l) => l.id === b.primaryLocationId)?.logoUrl ??
        locations.find((l) => l.logoUrl)?.logoUrl ??
        null,
    }));
    const branding = await this.db()
      .tenantBranding.findUnique({ where: { tenantId: actor.tenantId }, select: { primaryColor: true } })
      .catch(() => null);
    return {
      enabled: this.isEnabled(),
      live: !!this.email?.isLive(),
      pricePer1000Minor: this.pricePer1000Minor(),
      freePerMonth: this.freePerMonth(),
      usedThisMonth: await this.usedThisMonth(actor.tenantId),
      fromAddress: this.fromAddress() ?? null,
      primaryColor: branding?.primaryColor ?? null,
      brands,
    };
  }

  /** Emails this tenant has queued this calendar month (the free allowance). */
  async usedThisMonth(tenantId: string): Promise<number> {
    const start = new Date();
    start.setUTCDate(1);
    start.setUTCHours(0, 0, 0, 0);
    return this.db().emailCampaignRecipient.count({
      where: { tenantId, createdAt: { gte: start }, status: { not: "SKIPPED" } },
    });
  }

  // ── Contacts ──────────────────────────────────────────────────────────────

  async listContacts(
    actor: Actor,
    opts: { locationId?: string | null; status?: string; search?: string; limit?: number; offset?: number },
  ) {
    const locIds = await this.scope(actor, opts.locationId);
    const params: unknown[] = [actor.tenantId];
    const p = (v: unknown) => {
      params.push(v);
      return `$${params.length}`;
    };
    const base: string[] = [`ec."tenantId" = $1`];
    if (locIds) {
      const l = p(locIds);
      base.push(`(ec."locationId" = ANY(${l}::text[]) OR ec.email IN (
        SELECT ${ORDER_EMAIL_SQL} FROM orders o
        LEFT JOIN customer_accounts ca ON ca.id = o."customerAccountId"
        LEFT JOIN customers c ON c.id = o."customerId"
        WHERE o."tenantId" = $1 AND o."locationId" = ANY(${l}::text[])))`);
    }
    const filtered = [...base];
    if (opts.status) filtered.push(`ec.status = ${p(opts.status)}`);
    if (opts.search?.trim()) {
      const q = p(`%${opts.search.trim().toLowerCase()}%`);
      filtered.push(
        `(ec.email LIKE ${q} OR lower(COALESCE(ec."firstName", '')) LIKE ${q} OR lower(COALESCE(ec."lastName", '')) LIKE ${q})`,
      );
    }
    const limit = Math.min(Math.max(Number(opts.limit) || 100, 1), 500);
    const offset = Math.max(Number(opts.offset) || 0, 0);

    const [items, counts] = await Promise.all([
      this.prisma.$queryRawUnsafe<any[]>(
        `SELECT ec.* FROM email_contacts ec WHERE ${filtered.join(" AND ")}
         ORDER BY ec."createdAt" DESC LIMIT ${limit} OFFSET ${offset}`,
        ...params,
      ),
      this.prisma.$queryRawUnsafe<{ status: string; count: number }[]>(
        `SELECT ec.status, COUNT(*)::int AS count FROM email_contacts ec WHERE ${base.join(" AND ")} GROUP BY ec.status`,
        ...params.slice(0, locIds ? 2 : 1),
      ),
    ]);
    const byStatus: Record<string, number> = {};
    for (const r of counts) byStatus[r.status] = Number(r.count);
    const total = Object.values(byStatus).reduce((a, b) => a + b, 0);
    return { items, total, subscribed: byStatus.SUBSCRIBED ?? 0, byStatus };
  }

  /**
   * Add or refresh one contact. Returns what happened, for the import report.
   * A suppressed contact is never touched (rule 2).
   */
  private async upsertContact(args: {
    tenantId: string;
    email: string;
    firstName?: string | null;
    lastName?: string | null;
    locationId?: string | null;
    customerId?: string | null;
    customerAccountId?: string | null;
    source: string;
    consentSource: string;
    createdBy?: string | null;
  }): Promise<"added" | "updated" | "suppressed"> {
    const existing = await this.db().emailContact.findUnique({
      where: { tenantId_email: { tenantId: args.tenantId, email: args.email } },
    });
    if (existing) {
      if (existing.status !== "SUBSCRIBED") return "suppressed";
      await this.db().emailContact.update({
        where: { id: existing.id },
        data: {
          firstName: existing.firstName ?? args.firstName ?? null,
          lastName: existing.lastName ?? args.lastName ?? null,
          locationId: existing.locationId ?? args.locationId ?? null,
          customerId: existing.customerId ?? args.customerId ?? null,
          customerAccountId: existing.customerAccountId ?? args.customerAccountId ?? null,
        },
      });
      return "updated";
    }
    try {
      await this.db().emailContact.create({
        data: {
          tenantId: args.tenantId,
          email: args.email,
          firstName: args.firstName ?? null,
          lastName: args.lastName ?? null,
          locationId: args.locationId ?? null,
          customerId: args.customerId ?? null,
          customerAccountId: args.customerAccountId ?? null,
          status: "SUBSCRIBED",
          source: args.source,
          consentSource: args.consentSource,
          consentAt: new Date(),
          createdBy: args.createdBy ?? null,
        },
      });
      return "added";
    } catch (e: any) {
      // Two imports racing on one address: the other one created it.
      if (e?.code === "P2002") return "updated";
      throw e;
    }
  }

  private splitName(name?: string | null): [string | null, string | null] {
    const n = String(name ?? "").trim();
    if (!n) return [null, null];
    const parts = n.split(/\s+/);
    return [parts[0] ?? null, parts.slice(1).join(" ") || null];
  }

  /** A list the restaurant uploads. They must declare these people agreed. */
  async importRows(
    actor: Actor,
    rows: EmailImportRow[],
    opts: { locationId?: string | null; assertConsent: boolean },
  ): Promise<EmailImportReport> {
    if (!opts.assertConsent) {
      throw new BadRequestException(
        "Please confirm these customers agreed to receive marketing emails from you.",
      );
    }
    if (!Array.isArray(rows) || !rows.length) throw new BadRequestException("No rows to import.");
    if (rows.length > 20_000) {
      throw new BadRequestException("Please split the list into files of 20,000 or fewer.");
    }
    const locIds = await this.scope(actor, opts.locationId);
    const locationId = opts.locationId ?? (locIds?.length === 1 ? locIds[0] : null);
    if (!this.isTenantWide(actor) && !locationId) {
      throw new BadRequestException("Pick the location these contacts belong to.");
    }
    const report: EmailImportReport = {
      added: 0, updated: 0, duplicatesInFile: 0, invalid: 0, suppressed: 0, total: rows.length,
    };
    const seen = new Set<string>();
    for (const r of rows) {
      const email = normaliseEmail(r?.email);
      if (!email) { report.invalid++; continue; }
      if (seen.has(email)) { report.duplicatesInFile++; continue; }
      seen.add(email);
      let first = r.firstName?.trim() || null;
      let last = r.lastName?.trim() || null;
      if (!first && r.name) [first, last] = this.splitName(r.name);
      const res = await this.upsertContact({
        tenantId: actor.tenantId, email, firstName: first, lastName: last, locationId,
        source: "IMPORT", consentSource: "import:asserted", createdBy: actor.userId,
      });
      report[res]++;
    }
    return report;
  }

  /** How many customers with an email each of OUR channels has. */
  async orderSourceCounts(actor: Actor, locationId?: string | null) {
    const locIds = await this.scope(actor, locationId);
    const params: unknown[] = [actor.tenantId, EMAIL_IMPORT_SOURCES];
    const scope = locIds ? `AND o."locationId" = ANY($3::text[])` : "";
    if (locIds) params.push(locIds);
    const rows = await this.prisma.$queryRawUnsafe<{ source: string; count: number }[]>(
      `SELECT o."orderSource"::text AS source, COUNT(DISTINCT ${ORDER_EMAIL_SQL})::int AS count
       FROM orders o
       LEFT JOIN customer_accounts ca ON ca.id = o."customerAccountId"
       LEFT JOIN customers c ON c.id = o."customerId"
       WHERE o."tenantId" = $1 AND o."orderSource"::text = ANY($2::text[]) AND o."isSandbox" = false
         AND ${ORDER_EMAIL_SQL} LIKE '%@%' ${scope}
       GROUP BY 1`,
      ...params,
    );
    const map = new Map(rows.map((r) => [r.source, Number(r.count)]));
    return EMAIL_IMPORT_SOURCES.map((s) => ({ source: s, count: map.get(s) ?? 0 }));
  }

  /** Pull in past customers from our own channels (rule 3), consent asserted. */
  async importFromOrders(
    actor: Actor,
    opts: { sources: string[]; locationId?: string | null; assertConsent: boolean },
  ): Promise<EmailImportReport> {
    if (!opts.assertConsent) {
      throw new BadRequestException(
        "Please confirm these customers agreed to receive marketing emails from you.",
      );
    }
    const sources = (opts.sources ?? []).filter((s) => EMAIL_IMPORT_SOURCES.includes(s));
    if (!sources.length) throw new BadRequestException("Pick at least one channel to import from.");
    const locIds = await this.scope(actor, opts.locationId);
    const params: unknown[] = [actor.tenantId, sources];
    const scope = locIds ? `AND o."locationId" = ANY($3::text[])` : "";
    if (locIds) params.push(locIds);
    const rows = await this.prisma.$queryRawUnsafe<any[]>(
      `SELECT DISTINCT ON (${ORDER_EMAIL_SQL}) ${ORDER_EMAIL_SQL} AS email,
              COALESCE(ca."firstName", c."firstName") AS "firstName",
              COALESCE(ca."lastName", c."lastName") AS "lastName",
              o."customerName" AS "customerName", o."customerId" AS "customerId",
              o."customerAccountId" AS "customerAccountId", o."locationId" AS "locationId",
              o."orderSource"::text AS source
       FROM orders o
       LEFT JOIN customer_accounts ca ON ca.id = o."customerAccountId"
       LEFT JOIN customers c ON c.id = o."customerId"
       WHERE o."tenantId" = $1 AND o."orderSource"::text = ANY($2::text[]) AND o."isSandbox" = false
         AND ${ORDER_EMAIL_SQL} LIKE '%@%' ${scope}
       ORDER BY ${ORDER_EMAIL_SQL}, o."createdAt" DESC
       LIMIT 50000`,
      ...params,
    );
    const report: EmailImportReport = {
      added: 0, updated: 0, duplicatesInFile: 0, invalid: 0, suppressed: 0, total: rows.length,
    };
    for (const r of rows) {
      const email = normaliseEmail(r.email);
      if (!email) { report.invalid++; continue; }
      let first = r.firstName ?? null;
      let last = r.lastName ?? null;
      if (!first) [first, last] = this.splitName(r.customerName);
      const res = await this.upsertContact({
        tenantId: actor.tenantId, email, firstName: first, lastName: last,
        locationId: opts.locationId ?? r.locationId ?? null,
        customerId: r.customerId ?? null, customerAccountId: r.customerAccountId ?? null,
        source: r.source, consentSource: `import:asserted:${r.source}`, createdBy: actor.userId,
      });
      report[res]++;
    }
    return report;
  }

  async addManual(
    actor: Actor,
    body: { email: string; firstName?: string; lastName?: string; locationId?: string | null },
  ) {
    const email = normaliseEmail(body?.email);
    if (!email) throw new BadRequestException("That doesn't look like a valid email address.");
    const locIds = await this.scope(actor, body.locationId);
    const locationId = body.locationId ?? (locIds?.length === 1 ? locIds[0] : null);
    const res = await this.upsertContact({
      tenantId: actor.tenantId, email, firstName: body.firstName?.trim() || null,
      lastName: body.lastName?.trim() || null, locationId,
      source: "MANUAL", consentSource: "manual", createdBy: actor.userId,
    });
    if (res === "suppressed") {
      throw new BadRequestException(
        "This address unsubscribed or bounced, so it can't be added back. Only the customer can opt in again.",
      );
    }
    return { ok: true, result: res };
  }

  /** The restaurant removing someone from the list (a phone call, a request). */
  async unsubscribeContact(actor: Actor, id: string) {
    const c = await this.db().emailContact.findFirst({ where: { id, tenantId: actor.tenantId } });
    if (!c) throw new NotFoundException("Contact not found");
    if (c.locationId) await this.scope(actor, c.locationId);
    else if (!this.isTenantWide(actor)) throw new ForbiddenException("You can't change this contact.");
    if (c.status === "SUBSCRIBED") {
      await this.db().emailContact.update({
        where: { id },
        data: { status: "UNSUBSCRIBED", unsubscribedAt: new Date(), consentSource: "operator" },
      });
    }
    return { ok: true };
  }

  /**
   * Checkout's "Email me offers" box. Ticked = subscribe (or resubscribe: a
   * fresh tick is fresh consent). Unticked does NOTHING — the box starts
   * unticked, so leaving it alone is not a request to be removed.
   */
  @OnEvent("email-marketing.consent")
  async onCheckoutConsent(ev: {
    tenantId: string;
    locationId?: string | null;
    email?: string | null;
    firstName?: string | null;
    lastName?: string | null;
    customerAccountId?: string | null;
    source?: string | null;
  }): Promise<void> {
    try {
      const email = normaliseEmail(ev.email);
      if (!email || !ev.tenantId) return;
      const existing = await this.db().emailContact.findUnique({
        where: { tenantId_email: { tenantId: ev.tenantId, email } },
      });
      if (existing) {
        if (existing.status === "BOUNCED" || existing.status === "COMPLAINED") return;
        await this.db().emailContact.update({
          where: { id: existing.id },
          data: {
            status: "SUBSCRIBED",
            consentSource: existing.status === "SUBSCRIBED" ? existing.consentSource : "checkout",
            consentAt: existing.status === "SUBSCRIBED" ? existing.consentAt : new Date(),
            unsubscribedAt: null,
            firstName: existing.firstName ?? ev.firstName ?? null,
            lastName: existing.lastName ?? ev.lastName ?? null,
            locationId: existing.locationId ?? ev.locationId ?? null,
            customerAccountId: existing.customerAccountId ?? ev.customerAccountId ?? null,
          },
        });
        return;
      }
      await this.upsertContact({
        tenantId: ev.tenantId, email, firstName: ev.firstName ?? null, lastName: ev.lastName ?? null,
        locationId: ev.locationId ?? null, customerAccountId: ev.customerAccountId ?? null,
        source: ev.source ?? "ONLINE", consentSource: "checkout",
      });
    } catch (e: any) {
      // Never disturbs an order.
      this.logger.warn(`Email consent capture failed: ${e?.message ?? e}`);
    }
  }

  // ── Campaigns ─────────────────────────────────────────────────────────────

  async listCampaigns(actor: Actor, locationId?: string | null) {
    const locIds = await this.scope(actor, locationId);
    const where: any = { tenantId: actor.tenantId };
    if (locIds) where.locationId = { in: locIds };
    return this.db().emailCampaign.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take: 200,
      select: {
        id: true, name: true, subject: true, status: true, locationId: true, brandId: true,
        templateId: true, scheduledAt: true, startedAt: true, completedAt: true, lastError: true,
        recipientCount: true, sentCount: true, deliveredCount: true, openCount: true,
        clickCount: true, bounceCount: true, unsubscribeCount: true, chargedMinor: true,
        refundedMinor: true, createdAt: true, updatedAt: true,
      },
    });
  }

  /** Load a campaign the actor may touch. */
  async loadCampaign(actor: Actor, id: string): Promise<any> {
    const c = await this.db().emailCampaign.findFirst({ where: { id, tenantId: actor.tenantId } });
    if (!c) throw new NotFoundException("Campaign not found");
    if (c.locationId) await this.scope(actor, c.locationId);
    else if (!this.isTenantWide(actor)) throw new ForbiddenException("You don't have access to this campaign.");
    return c;
  }

  async getCampaign(actor: Actor, id: string) {
    const c = await this.loadCampaign(actor, id);
    return { ...c, results: await this.results(c) };
  }

  /** Orders and revenue the email brought in — from the attribution stamped
   *  on orders at checkout, counted only for orders that really happened. */
  async results(c: any): Promise<{ orders: number; revenue: number; currency: string }> {
    const currency = await this.currencyFor(c.locationId);
    if (!c.startedAt) return { orders: 0, revenue: 0, currency };
    const rows = await this.prisma.$queryRawUnsafe<{ orders: number; revenue: number }[]>(
      `SELECT COUNT(*)::int AS orders, COALESCE(SUM(total), 0)::float AS revenue
       FROM orders
       WHERE "tenantId" = $1 AND "createdAt" >= $2
         AND metadata->'emailAttribution'->>'campaignId' = $3
         AND status::text NOT IN ('${NOT_REAL_ORDER.join("','")}')`,
      c.tenantId,
      c.startedAt,
      c.id,
    );
    return { orders: Number(rows[0]?.orders ?? 0), revenue: Number(rows[0]?.revenue ?? 0), currency };
  }

  private async currencyFor(locationId?: string | null): Promise<string> {
    if (!locationId) return "GBP";
    const loc = await this.prisma.location.findUnique({ where: { id: locationId }, select: { currency: true } });
    return loc?.currency ?? "GBP";
  }

  /** A campaign must say who it is from and whose wallet pays. */
  private async resolveSender(actor: Actor, brandId?: string | null, locationId?: string | null) {
    const locIds = await this.scope(actor, locationId);
    const loc = locationId ?? (locIds?.length === 1 ? locIds[0]! : null);
    if (!loc && !this.isTenantWide(actor)) {
      throw new BadRequestException("Pick the location this campaign is for.");
    }
    let brand: any = null;
    if (brandId) {
      brand = await this.prisma.brand.findFirst({
        where: { id: brandId, tenantId: actor.tenantId, deletedAt: null },
        select: { id: true, name: true, logoUrl: true, topSellerItemIds: true, primaryLocationId: true },
      });
      if (!brand) throw new BadRequestException("Brand not found");
    } else if (loc) {
      const l = await this.prisma.location.findUnique({ where: { id: loc }, select: { brandId: true } });
      if (l?.brandId) {
        brand = await this.prisma.brand.findUnique({
          where: { id: l.brandId },
          select: { id: true, name: true, logoUrl: true, topSellerItemIds: true, primaryLocationId: true },
        });
      }
    }
    return { brand, locationId: loc };
  }

  async createCampaign(
    actor: Actor,
    body: { templateId?: string; brandId?: string | null; locationId?: string | null; name?: string },
  ) {
    const { brand, locationId } = await this.resolveSender(actor, body.brandId, body.locationId);
    const tpl = EMAIL_TEMPLATES.find((t) => t.id === body.templateId) ?? EMAIL_TEMPLATES.find((t) => t.id === "blank")!;
    const branding = await this.db()
      .tenantBranding.findUnique({ where: { tenantId: actor.tenantId }, select: { primaryColor: true } })
      .catch(() => null);
    const hero = brand
      ? await this.db()
          .directOrderingConfig.findUnique({ where: { brandId: brand.id }, select: { heroImageUrl: true } })
          .catch(() => null)
      : null;
    const products = brand ? await this.products(actor, { brandId: brand.id, locationId, ids: brand.topSellerItemIds, limit: 4 }) : [];
    const design = tpl.build({
      brandName: brand?.name ?? "",
      primaryColor: branding?.primaryColor ?? null,
      products,
      heroImageUrl: hero?.heroImageUrl ?? null,
    });
    return this.db().emailCampaign.create({
      data: {
        tenantId: actor.tenantId,
        locationId,
        brandId: brand?.id ?? null,
        name: body.name?.trim() || tpl.name,
        subject: tpl.subject,
        preheader: tpl.preheader || null,
        fromName: brand?.name ?? null,
        templateId: tpl.id,
        design: design as any,
        audience: tpl.audience as any,
        createdBy: actor.userId ?? null,
      },
    });
  }

  async updateCampaign(
    actor: Actor,
    id: string,
    body: {
      name?: string; subject?: string; preheader?: string | null; fromName?: string | null;
      replyTo?: string | null; design?: EmailDesign; audience?: EmailAudience;
      brandId?: string | null; locationId?: string | null;
    },
  ) {
    const c = await this.loadCampaign(actor, id);
    if (c.status !== "DRAFT" && c.status !== "SCHEDULED") {
      throw new BadRequestException("This campaign has already been sent and can't be edited.");
    }
    const data: any = {};
    if (body.name !== undefined) data.name = String(body.name).trim().slice(0, 120) || "Untitled campaign";
    if (body.subject !== undefined) data.subject = String(body.subject).slice(0, 200);
    if (body.preheader !== undefined) data.preheader = body.preheader ? String(body.preheader).slice(0, 200) : null;
    if (body.fromName !== undefined) data.fromName = body.fromName ? String(body.fromName).slice(0, 80) : null;
    if (body.replyTo !== undefined) {
      const r = body.replyTo ? normaliseEmail(body.replyTo) : null;
      if (body.replyTo && !r) throw new BadRequestException("Reply-to must be a valid email address.");
      data.replyTo = r;
    }
    if (body.design !== undefined) {
      if (!body.design || !Array.isArray((body.design as any).blocks)) {
        throw new BadRequestException("Invalid email design.");
      }
      if (JSON.stringify(body.design).length > 200_000) throw new BadRequestException("This email is too large.");
      data.design = body.design;
    }
    if (body.audience !== undefined) data.audience = body.audience ?? {};
    if (body.brandId !== undefined || body.locationId !== undefined) {
      const { brand, locationId } = await this.resolveSender(
        actor,
        body.brandId !== undefined ? body.brandId : c.brandId,
        body.locationId !== undefined ? body.locationId : c.locationId,
      );
      data.brandId = brand?.id ?? null;
      data.locationId = locationId;
    }
    return this.db().emailCampaign.update({ where: { id }, data });
  }

  async duplicateCampaign(actor: Actor, id: string) {
    const c = await this.loadCampaign(actor, id);
    return this.db().emailCampaign.create({
      data: {
        tenantId: c.tenantId, locationId: c.locationId, brandId: c.brandId,
        name: `${c.name} (copy)`.slice(0, 120), subject: c.subject, preheader: c.preheader,
        fromName: c.fromName, replyTo: c.replyTo, templateId: c.templateId,
        design: c.design, audience: c.audience, createdBy: actor.userId ?? null,
      },
    });
  }

  async deleteCampaign(actor: Actor, id: string) {
    const c = await this.loadCampaign(actor, id);
    if (!["DRAFT", "CANCELLED", "FAILED"].includes(c.status) || c.startedAt) {
      throw new BadRequestException("Sent campaigns are kept for your records and can't be deleted.");
    }
    await this.db().emailCampaign.delete({ where: { id } });
    return { ok: true };
  }

  // ── Products for the editor ──────────────────────────────────────────────

  async products(
    actor: Actor,
    opts: { brandId?: string | null; locationId?: string | null; search?: string; ids?: string[]; limit?: number },
  ): Promise<EmailProduct[]> {
    if (!opts.brandId) return [];
    const brand = await this.prisma.brand.findFirst({
      where: { id: opts.brandId, tenantId: actor.tenantId },
      select: { id: true },
    });
    if (!brand) return [];
    const where: any = {
      OR: [{ brandId: brand.id }, { brandIds: { has: brand.id } }],
      isAvailable: true,
      visibleToCustomers: true,
    };
    if (opts.ids?.length) where.id = { in: opts.ids };
    if (opts.search?.trim()) where.name = { contains: opts.search.trim(), mode: "insensitive" };
    const items = await this.prisma.menuItem.findMany({
      where,
      select: { id: true, name: true, description: true, basePrice: true, imageUrl: true },
      orderBy: [{ imageUrl: { sort: "asc", nulls: "last" } }, { name: "asc" }],
      take: 300,
    });
    const currency = await this.currencyFor(opts.locationId);
    // Menus are copied per shop, so one dish exists many times; show it once.
    const seen = new Set<string>();
    const out: EmailProduct[] = [];
    for (const it of items) {
      const key = it.name.trim().toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        id: it.id,
        name: it.name,
        description: it.description ?? null,
        price: formatMoney(Number(it.basePrice ?? 0), currency),
        imageUrl: it.imageUrl ?? null,
      });
      if (out.length >= (opts.limit ?? 120)) break;
    }
    return out;
  }

  // ── Audience + cost ──────────────────────────────────────────────────────

  async countAudience(tenantId: string, audience: any, locationId: string | null): Promise<number> {
    const q = buildAudienceQuery(tenantId, audience, locationId ? [locationId] : null, "count");
    const rows = await this.prisma.$queryRawUnsafe<{ count: number }[]>(q.sql, ...q.params);
    return Number(rows[0]?.count ?? 0);
  }

  async audienceRows(
    tenantId: string,
    audience: any,
    locationId: string | null,
  ): Promise<{ id: string; email: string; firstName: string | null }[]> {
    const q = buildAudienceQuery(tenantId, audience, locationId ? [locationId] : null, "rows");
    return this.prisma.$queryRawUnsafe<any[]>(q.sql, ...q.params);
  }

  async estimate(actor: Actor, body: { campaignId?: string; audience?: any; locationId?: string | null }) {
    let audience = body.audience;
    let locationId = body.locationId ?? null;
    if (body.campaignId) {
      const c = await this.loadCampaign(actor, body.campaignId);
      audience = body.audience ?? c.audience;
      locationId = body.locationId !== undefined ? body.locationId : c.locationId;
    }
    if (locationId) await this.scope(actor, locationId);
    else if (!this.isTenantWide(actor)) throw new BadRequestException("Pick a location.");
    const recipients = await this.countAudience(actor.tenantId, audience ?? {}, locationId);
    return this.priceFor(actor.tenantId, locationId, recipients);
  }

  private async priceFor(tenantId: string, locationId: string | null, recipients: number) {
    const used = await this.usedThisMonth(tenantId);
    const freeRemaining = Math.max(0, this.freePerMonth() - used);
    const free = Math.min(recipients, freeRemaining);
    const billable = recipients - free;
    const price = this.pricePer1000Minor();
    const costMinor = emailCostMinor(billable, price);
    const wallet = await this.wallet.getSummary(tenantId, locationId);
    return {
      recipients,
      freeRemaining,
      free,
      billable,
      pricePer1000Minor: price,
      costMinor,
      balanceMinor: wallet.balanceMinor,
      currency: wallet.currency,
      canAfford: wallet.balanceMinor >= costMinor,
      enabled: this.isEnabled(),
    };
  }

  // ── Rendering ────────────────────────────────────────────────────────────

  /** Everything the renderer needs that isn't per-recipient. */
  async renderContext(c: any) {
    const brand = c.brandId
      ? await this.prisma.brand.findUnique({
          where: { id: c.brandId },
          select: {
            id: true, name: true, logoUrl: true, onlineOrderingSlug: true, primaryLocationId: true,
            addressLine1: true, addressLine2: true, city: true, postcode: true,
          },
        })
      : null;
    const locId = c.locationId ?? brand?.primaryLocationId ?? null;
    const loc = locId
      ? await this.prisma.location.findUnique({
          where: { id: locId },
          select: {
            id: true, name: true, brandId: true, onlineOrderingSlug: true, slug: true,
            addressLine1: true, city: true, postcode: true, logoUrl: true,
          },
        })
      : null;
    const base = this.webBase();
    let storefrontUrl = base;
    if (loc) {
      const slug = loc.onlineOrderingSlug || loc.slug || loc.id;
      // ?brand= replaces the storefront's menu and name, so only pin a brand
      // this shop actually trades as.
      const pin =
        brand && brand.id !== loc.brandId && brand.primaryLocationId === loc.id ? `?brand=${encodeURIComponent(brand.id)}` : "";
      storefrontUrl = `${base}/order/${encodeURIComponent(slug)}${pin}`;
    } else if (brand?.onlineOrderingSlug) {
      storefrontUrl = `${base}/brand/${encodeURIComponent(brand.onlineOrderingSlug)}`;
    }
    const address = [
      loc?.addressLine1 ?? brand?.addressLine1,
      loc ? null : brand?.addressLine2,
      loc?.city ?? brand?.city,
      loc?.postcode ?? brand?.postcode,
    ]
      .filter((s) => s && String(s).trim())
      .join(", ");
    const brandName = String(c.fromName || brand?.name || loc?.name || "Our restaurant");
    return {
      brandName,
      // Same order the storefront uses: the brand's logo, else the shop's.
      logoUrl: brand?.logoUrl ?? loc?.logoUrl ?? null,
      storefrontUrl,
      footerAddress: address || null,
      // Menu photos are often stored as relative proxy paths.
      assetBaseUrl: base,
    };
  }

  /** Append the attribution parameter to a storefront link. */
  attributedUrl(url: string, recipientId: string, campaignId: string): string {
    const sep = url.includes("?") ? "&" : "?";
    return `${url}${sep}er=${encodeURIComponent(recipientId)}&utm_source=email&utm_medium=email&utm_campaign=${encodeURIComponent(campaignId)}`;
  }

  unsubscribeUrl(token: string): string {
    return `${this.webBase()}/email/unsubscribe?t=${encodeURIComponent(token)}`;
  }

  // ── Test send ────────────────────────────────────────────────────────────

  async testSend(actor: Actor, id: string, to: string[]) {
    const c = await this.loadCampaign(actor, id);
    const addresses = Array.from(new Set((to ?? []).map(normaliseEmail).filter(Boolean))) as string[];
    if (!addresses.length) throw new BadRequestException("Enter an email address for the test.");
    if (addresses.length > 5) throw new BadRequestException("Send a test to at most 5 addresses.");
    if (!c.subject?.trim()) throw new BadRequestException("Add a subject line first.");
    if (!this.email) throw new BadRequestException("Email isn't configured.");
    const ctx = await this.renderContext(c);
    const rendered = renderEmail(c.design as unknown as EmailDesign, {
      ...ctx,
      firstName: null,
      preheader: c.preheader,
      // A test has no recipient row, so it carries a link to the page in
      // preview mode rather than one that could unsubscribe anybody.
      unsubscribeUrl: `${this.webBase()}/email/unsubscribe?t=test`,
    });
    // Through the same sender as the real campaign, so a test proves the
    // marketing domain works — not just the order-confirmation one.
    await this.email.sendBatch(
      addresses.map((address) => ({
        to: address,
        subject: `[Test] ${personalise(c.subject, { brandName: ctx.brandName })}`,
        html: rendered.html,
        text: rendered.text,
        fromName: ctx.brandName,
        fromAddress: this.fromAddress(),
        replyTo: c.replyTo ?? undefined,
      })),
    );
    return { ok: true, sentTo: addresses };
  }

  // ── Send / schedule / cancel ─────────────────────────────────────────────

  private assertSendable(c: any) {
    if (!this.isEnabled()) {
      throw new BadRequestException(
        "Email marketing isn't switched on for your account yet. Contact support to enable it.",
      );
    }
    if (!c.subject?.trim()) throw new BadRequestException("Add a subject line before sending.");
    const blocks = (c.design as any)?.blocks ?? [];
    if (!Array.isArray(blocks) || blocks.length === 0) throw new BadRequestException("The email is empty.");
    if (!c.locationId && !c.brandId) throw new BadRequestException("Pick who this email is from.");
  }

  async sendNow(actor: Actor, id: string) {
    const c = await this.loadCampaign(actor, id);
    if (!["DRAFT", "SCHEDULED"].includes(c.status)) {
      throw new BadRequestException("This campaign has already been sent.");
    }
    this.assertSendable(c);
    const res = await this.materialize(c.id, actor.userId ?? null, { throwOnError: true });
    return { ok: true, ...res };
  }

  async schedule(actor: Actor, id: string, at: string) {
    const c = await this.loadCampaign(actor, id);
    if (!["DRAFT", "SCHEDULED"].includes(c.status)) {
      throw new BadRequestException("This campaign has already been sent.");
    }
    this.assertSendable(c);
    const when = new Date(at);
    if (Number.isNaN(when.getTime())) throw new BadRequestException("Pick a valid date and time.");
    if (when.getTime() < Date.now() + 60_000) throw new BadRequestException("Pick a time in the future.");
    if (when.getTime() > Date.now() + 90 * 86400_000) {
      throw new BadRequestException("Campaigns can be scheduled up to 90 days ahead.");
    }
    const recipients = await this.countAudience(c.tenantId, c.audience, c.locationId);
    if (recipients === 0) throw new BadRequestException("No subscribers match this audience.");
    return this.db().emailCampaign.update({
      where: { id },
      data: { status: "SCHEDULED", scheduledAt: when, lastError: null },
    });
  }

  async cancel(actor: Actor, id: string) {
    const c = await this.loadCampaign(actor, id);
    if (c.status === "SCHEDULED") {
      return this.db().emailCampaign.update({ where: { id }, data: { status: "DRAFT", scheduledAt: null } });
    }
    if (c.status === "SENDING") {
      // Stop what hasn't gone yet. A batch already handed to Resend can't be
      // recalled; its rows are SENDING and will be recorded when it returns.
      await this.db().emailCampaignRecipient.updateMany({
        where: { campaignId: id, status: "PENDING" },
        data: { status: "SKIPPED", error: "cancelled" },
      });
      await this.db().emailCampaign.update({ where: { id }, data: { status: "CANCELLED" } });
      return { ok: true };
    }
    throw new BadRequestException("Only scheduled or sending campaigns can be cancelled.");
  }

  /**
   * Turn a campaign into a recipient list and charge for it. Called by "Send
   * now" and by the scheduler when a scheduled campaign comes due.
   *
   * The status flip is the lock: only one caller can move DRAFT/SCHEDULED to
   * SENDING, so a double-click or the scheduler racing a manual send can't
   * charge or queue twice.
   */
  async materialize(
    campaignId: string,
    actorUserId: string | null,
    opts: { throwOnError: boolean },
  ): Promise<{ recipients: number; chargedMinor: number }> {
    const c = await this.db().emailCampaign.findUnique({ where: { id: campaignId } });
    if (!c) throw new NotFoundException("Campaign not found");
    const fromStatus = c.status;
    const claimed = await this.db().emailCampaign.updateMany({
      where: { id: campaignId, status: { in: ["DRAFT", "SCHEDULED"] } },
      data: { status: "SENDING", startedAt: new Date(), lastError: null },
    });
    if (claimed.count === 0) throw new BadRequestException("This campaign is already sending.");

    const fail = async (message: string) => {
      // Send-now hands the campaign back to the operator to fix; a scheduled
      // one that fails unattended is marked FAILED so it shows up as such.
      await this.db().emailCampaign.update({
        where: { id: campaignId },
        data:
          opts.throwOnError && fromStatus === "DRAFT"
            ? { status: "DRAFT", startedAt: null, lastError: message }
            : { status: "FAILED", startedAt: null, lastError: message },
      });
      if (opts.throwOnError) throw new BadRequestException(message);
      return { recipients: 0, chargedMinor: 0 };
    };

    const rows = await this.audienceRows(c.tenantId, c.audience, c.locationId);
    if (!rows.length) return fail("No subscribers match this audience.");

    const price = await this.priceFor(c.tenantId, c.locationId, rows.length);
    let chargedMinor = 0;
    if (price.costMinor > 0) {
      try {
        const r = await this.wallet.debitForEmailMarketing({
          tenantId: c.tenantId,
          locationId: c.locationId,
          campaignId,
          emails: price.billable,
          amountMinor: price.costMinor,
          createdBy: actorUserId,
        });
        chargedMinor = r.chargedMinor;
      } catch (e: any) {
        return fail(e?.message ?? "Not enough wallet balance.");
      }
    }

    try {
      // One dry render to record every link — the click redirect table.
      const ctx = await this.renderContext(c);
      const dry = renderEmail(c.design as unknown as EmailDesign, { ...ctx, unsubscribeUrl: "", preheader: c.preheader });
      await this.db().emailCampaign.update({
        where: { id: campaignId },
        data: {
          links: dry.links as any,
          recipientCount: rows.length,
          freeUsed: price.free,
          chargedMinor,
          sentCount: 0, failedCount: 0, skippedCount: 0,
        },
      });
      for (let i = 0; i < rows.length; i += 1000) {
        await this.db().emailCampaignRecipient.createMany({
          data: rows.slice(i, i + 1000).map((r) => ({
            campaignId,
            tenantId: c.tenantId,
            contactId: r.id,
            email: r.email,
            firstName: r.firstName ?? null,
            status: "PENDING",
          })),
          skipDuplicates: true,
        });
      }
    } catch (e: any) {
      // Nothing has been sent: give the money back and stop.
      if (chargedMinor > 0) {
        await this.wallet.refundEmailMarketing({
          tenantId: c.tenantId, locationId: c.locationId, campaignId, amountMinor: chargedMinor,
          reason: "could not prepare the send",
        });
      }
      await this.db().emailCampaignRecipient.deleteMany({ where: { campaignId } }).catch(() => null);
      await this.db().emailCampaign.update({ where: { id: campaignId }, data: { chargedMinor: 0 } }).catch(() => null);
      this.logger.error(`Email campaign ${campaignId} could not be prepared: ${e?.message ?? e}`);
      return fail("Something went wrong preparing this campaign. You have not been charged.");
    }

    this.logger.log(
      `Email campaign ${campaignId} queued: ${rows.length} recipients, ${price.free} free, charged ${chargedMinor}`,
    );
    return { recipients: rows.length, chargedMinor };
  }

  // ── Public: unsubscribe ──────────────────────────────────────────────────

  private async contactFromToken(token: string) {
    const t = readEmailToken(this.tokenSecret(), token);
    if (!t) return null;
    if (t.kind === "c") {
      const contact = await this.db().emailContact.findUnique({ where: { id: t.id } });
      return contact ? { contact, recipient: null as any } : null;
    }
    const recipient = await this.db().emailCampaignRecipient.findUnique({ where: { id: t.id } });
    if (!recipient) return null;
    const contact = await this.db().emailContact.findUnique({ where: { id: recipient.contactId } });
    return contact ? { contact, recipient } : null;
  }

  private async brandNameFor(contact: any, recipient: any): Promise<string> {
    if (recipient) {
      const c = await this.db().emailCampaign.findUnique({
        where: { id: recipient.campaignId },
        select: { fromName: true, brandId: true },
      });
      if (c?.fromName) return c.fromName;
      if (c?.brandId) {
        const b = await this.prisma.brand.findUnique({ where: { id: c.brandId }, select: { name: true } });
        if (b?.name) return b.name;
      }
    }
    const b = await this.prisma.brand.findFirst({
      where: { tenantId: contact.tenantId, deletedAt: null },
      select: { name: true },
      orderBy: { createdAt: "asc" },
    });
    return b?.name ?? "this restaurant";
  }

  async unsubscribeInfo(token: string) {
    if (token === "test") {
      return { valid: true, test: true, brandName: "Your restaurant", email: "you@example.com", status: "SUBSCRIBED" };
    }
    const found = await this.contactFromToken(token);
    if (!found) return { valid: false };
    return {
      valid: true,
      test: false,
      brandName: await this.brandNameFor(found.contact, found.recipient),
      email: maskEmail(found.contact.email),
      status: found.contact.status,
    };
  }

  /** One click, no login, idempotent — Gmail's one-click POST lands here too. */
  async unsubscribe(token: string): Promise<{ ok: boolean }> {
    if (token === "test") return { ok: true };
    const found = await this.contactFromToken(token);
    if (!found) return { ok: false };
    const { contact, recipient } = found;
    if (contact.status === "SUBSCRIBED") {
      await this.db().emailContact.update({
        where: { id: contact.id },
        data: { status: "UNSUBSCRIBED", unsubscribedAt: new Date(), consentSource: "unsubscribe_link" },
      });
    }
    if (recipient && !recipient.unsubscribedAt) {
      const u = await this.db().emailCampaignRecipient.updateMany({
        where: { id: recipient.id, unsubscribedAt: null },
        data: { unsubscribedAt: new Date() },
      });
      if (u.count) {
        await this.db().emailCampaign.update({
          where: { id: recipient.campaignId },
          data: { unsubscribeCount: { increment: 1 } },
        });
      }
    }
    return { ok: true };
  }

  /** "Unsubscribed by mistake" — only from their own link, and never for a
   *  bounced or complained address. */
  async resubscribe(token: string): Promise<{ ok: boolean }> {
    const found = await this.contactFromToken(token);
    if (!found) return { ok: false };
    if (found.contact.status !== "UNSUBSCRIBED") return { ok: found.contact.status === "SUBSCRIBED" };
    await this.db().emailContact.update({
      where: { id: found.contact.id },
      data: { status: "SUBSCRIBED", unsubscribedAt: null, consentSource: "resubscribe", consentAt: new Date() },
    });
    return { ok: true };
  }

  makeRecipientToken(recipientId: string): string {
    return makeEmailToken(this.tokenSecret(), "r", recipientId);
  }

  // ── Public: tracking ─────────────────────────────────────────────────────

  async recordOpen(recipientId: string): Promise<void> {
    try {
      const r = await this.db().emailCampaignRecipient.findUnique({
        where: { id: recipientId },
        select: { id: true, campaignId: true, contactId: true, openedAt: true },
      });
      if (!r || r.openedAt) return;
      const u = await this.db().emailCampaignRecipient.updateMany({
        where: { id: r.id, openedAt: null },
        data: { openedAt: new Date() },
      });
      if (!u.count) return;
      await this.db().emailCampaign.update({ where: { id: r.campaignId }, data: { openCount: { increment: 1 } } });
      await this.db().emailContact.update({ where: { id: r.contactId }, data: { lastOpenedAt: new Date() } }).catch(() => null);
    } catch (e: any) {
      this.logger.warn(`Open tracking failed: ${e?.message ?? e}`);
    }
  }

  /** Where a tracked link goes. Only ever a URL the email itself contained. */
  async recordClick(recipientId: string, index: number): Promise<string> {
    const fallback = this.webBase();
    try {
      const r = await this.db().emailCampaignRecipient.findUnique({
        where: { id: recipientId },
        select: { id: true, campaignId: true, contactId: true, clickedAt: true, openedAt: true },
      });
      if (!r) return fallback;
      const c = await this.db().emailCampaign.findUnique({
        where: { id: r.campaignId },
        select: { id: true, links: true },
      });
      const link = Array.isArray(c?.links) ? (c!.links as any[])[index] : null;
      if (!link?.url) return fallback;
      const now = new Date();
      const first = await this.db().emailCampaignRecipient.updateMany({
        where: { id: r.id, clickedAt: null },
        data: { clickedAt: now },
      });
      if (first.count) {
        // A click proves an open even when the pixel was blocked.
        const opened = await this.db().emailCampaignRecipient.updateMany({
          where: { id: r.id, openedAt: null },
          data: { openedAt: now },
        });
        await this.db().emailCampaign.update({
          where: { id: c!.id },
          data: { clickCount: { increment: 1 }, ...(opened.count ? { openCount: { increment: 1 } } : {}) },
        });
        await this.db().emailContact.update({ where: { id: r.contactId }, data: { lastClickedAt: now } }).catch(() => null);
      }
      const url = String(link.url);
      if (!/^(https?:|mailto:|tel:)/i.test(url)) return fallback;
      return link.storefront ? this.attributedUrl(url, r.id, c!.id) : url;
    } catch (e: any) {
      this.logger.warn(`Click tracking failed: ${e?.message ?? e}`);
      return fallback;
    }
  }

  /**
   * Validate the "came from an email" marker the storefront sends at checkout.
   * Returns the attribution to stamp on the order, or null. Fourteen days is
   * the window: past that, the email isn't why they ordered.
   */
  async attributionFor(tenantId: string, recipientId?: string | null) {
    if (!recipientId || typeof recipientId !== "string" || recipientId.length > 40) return null;
    try {
      const r = await this.db().emailCampaignRecipient.findUnique({
        where: { id: recipientId },
        select: { id: true, tenantId: true, campaignId: true, sentAt: true },
      });
      if (!r || r.tenantId !== tenantId || !r.sentAt) return null;
      if (Date.now() - new Date(r.sentAt).getTime() > 14 * 86400_000) return null;
      return { campaignId: r.campaignId, recipientId: r.id };
    } catch {
      return null;
    }
  }

  // ── Public: Resend webhook ───────────────────────────────────────────────

  async handleResendEvent(evt: { type?: string; data?: any }): Promise<void> {
    const type = String(evt?.type ?? "");
    const emailId = evt?.data?.email_id;
    if (!emailId) return;
    const r = await this.db().emailCampaignRecipient.findFirst({
      where: { resendId: String(emailId) },
      select: { id: true, campaignId: true, contactId: true, deliveredAt: true, bouncedAt: true, complainedAt: true },
    });
    if (!r) return; // an order confirmation or other transactional email
    const now = new Date();
    if (type === "email.delivered") {
      const u = await this.db().emailCampaignRecipient.updateMany({
        where: { id: r.id, deliveredAt: null },
        data: { deliveredAt: now },
      });
      if (u.count) {
        await this.db().emailCampaign.update({ where: { id: r.campaignId }, data: { deliveredCount: { increment: 1 } } });
      }
    } else if (type === "email.bounced") {
      const bounceType = String(evt?.data?.bounce?.type ?? "");
      const u = await this.db().emailCampaignRecipient.updateMany({
        where: { id: r.id, bouncedAt: null },
        data: { bouncedAt: now },
      });
      if (u.count) {
        await this.db().emailCampaign.update({ where: { id: r.campaignId }, data: { bounceCount: { increment: 1 } } });
      }
      // A temporary bounce (full mailbox) is not a dead address.
      if (!/transient|soft|temporary/i.test(bounceType)) {
        await this.db().emailContact.updateMany({
          where: { id: r.contactId, status: { in: ["SUBSCRIBED", "UNSUBSCRIBED"] } },
          data: { status: "BOUNCED", suppressedAt: now },
        });
      }
    } else if (type === "email.complained") {
      const u = await this.db().emailCampaignRecipient.updateMany({
        where: { id: r.id, complainedAt: null },
        data: { complainedAt: now },
      });
      if (u.count) {
        await this.db().emailCampaign.update({ where: { id: r.campaignId }, data: { complaintCount: { increment: 1 } } });
      }
      await this.db().emailContact.updateMany({
        where: { id: r.contactId },
        data: { status: "COMPLAINED", suppressedAt: now },
      });
    }
  }
}

export function maskEmail(email: string): string {
  const [user, domain] = String(email).split("@");
  if (!user || !domain) return email;
  return `${user.slice(0, 2)}${"•".repeat(Math.max(1, Math.min(6, user.length - 2)))}@${domain}`;
}
