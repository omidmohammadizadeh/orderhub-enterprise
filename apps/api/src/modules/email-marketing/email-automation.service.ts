import { BadRequestException, Injectable, Logger, NotFoundException } from "@nestjs/common";
import { Cron } from "@nestjs/schedule";
import { createHash } from "crypto";
import {
  AUTOMATION_DEFAULTS,
  AUTOMATION_INFO,
  AUTOMATION_TEMPLATES,
  renderEmail,
  type EmailAutomationSettings,
  type EmailAutomationType,
  type EmailDesign,
} from "@orderhub/shared";
import { buildAutomationQuery, normaliseEmail } from "./email-audience";
import { EmailMarketingService, type Actor } from "./email-marketing.service";

// Welcome and win-back emails that send themselves.
//
// HOW A RUN WORKS (every 15 minutes, inside 10:00–20:00 shop time):
//   1. The offer code must still work — else the automation pauses itself.
//   2. buildAutomationQuery finds who is due (see its rules).
//   3. They are queued as PENDING recipients on a "ledger" EmailCampaign
//      (status AUTOMATION, automationId set). The campaign sender delivers
//      them, charging each batch before it goes; tracking, unsubscribes and
//      order attribution are the campaign machinery unchanged.
//
// A ledger belongs to one version of the email: editing it starts a new one,
// so a click on an old email still redirects by the links IT contained.

const TYPES: EmailAutomationType[] = ["WELCOME", "WIN_BACK"];
/** Most people one automation queues per run. */
const PER_RUN = 1000;
/** Send hours, shop time. Nobody wants a "we miss you" at 2am. */
const SEND_FROM_HOUR = 10;
const SEND_UNTIL_HOUR = 20;

@Injectable()
export class EmailAutomationService {
  private readonly logger = new Logger(EmailAutomationService.name);
  private running = false;

  constructor(private readonly svc: EmailMarketingService) {}

  private db() {
    return this.svc.db();
  }

  private settingsOf(a: { type: string; settings: unknown }): EmailAutomationSettings {
    return { ...AUTOMATION_DEFAULTS[a.type as EmailAutomationType], ...((a.settings as object) ?? {}) };
  }

  // ── Dashboard ─────────────────────────────────────────────────────────────

  async list(actor: Actor, locationId: string | null) {
    if (!locationId) throw new BadRequestException("Pick a shop to set up its automatic emails.");
    await this.svc.scope(actor, locationId);
    const rows = await this.db().emailAutomation.findMany({ where: { tenantId: actor.tenantId, locationId } });
    return Promise.all(
      TYPES.map(async (type) => {
        const a = rows.find((r) => r.type === type) ?? null;
        return { type, ...AUTOMATION_INFO[type], automation: a ? await this.withStats(a) : null };
      }),
    );
  }

  private async load(actor: Actor, id: string) {
    const a = await this.db().emailAutomation.findFirst({ where: { id, tenantId: actor.tenantId } });
    if (!a) throw new NotFoundException("Automation not found");
    await this.svc.scope(actor, a.locationId);
    return a;
  }

  async get(actor: Actor, id: string) {
    const a = await this.load(actor, id);
    // Same as a draft campaign: never show (or send) a photo that won't load.
    const cleaned = await this.svc.withoutBrokenImages(a.design as unknown as EmailDesign);
    if (cleaned.changed) {
      await this.db().emailAutomation.update({ where: { id }, data: { design: cleaned.design as any } });
      a.design = cleaned.design as any;
    }
    return { ...(await this.withStats(a)), dueNow: await this.dueCount(a) };
  }

  /** Set up a shop's automation from its starter email (or return the one it has). */
  async create(actor: Actor, body: { type: EmailAutomationType; locationId: string; brandId?: string | null }) {
    if (!TYPES.includes(body.type)) throw new BadRequestException("Unknown automation.");
    if (!body.locationId) throw new BadRequestException("Pick a shop first.");
    const existing = await this.db().emailAutomation.findFirst({
      where: { tenantId: actor.tenantId, locationId: body.locationId, type: body.type },
    });
    if (existing) return existing;
    const { brand, locationId } = await this.svc.resolveSender(actor, body.brandId ?? null, body.locationId);
    const tpl = AUTOMATION_TEMPLATES[body.type];
    const branding = await this.db()
      .tenantBranding.findUnique({ where: { tenantId: actor.tenantId }, select: { primaryColor: true } })
      .catch(() => null);
    const hero = brand
      ? await this.db()
          .directOrderingConfig.findUnique({ where: { brandId: brand.id }, select: { heroImageUrl: true } })
          .catch(() => null)
      : null;
    const design = tpl.build({
      brandName: brand?.name ?? "",
      primaryColor: branding?.primaryColor ?? null,
      products: brand ? await this.svc.starterProducts(actor, brand, locationId) : [],
      heroImageUrl: hero?.heroImageUrl ?? null,
    });
    try {
      return await this.db().emailAutomation.create({
        data: {
          tenantId: actor.tenantId,
          locationId: locationId!,
          brandId: brand?.id ?? null,
          type: body.type,
          subject: tpl.subject,
          preheader: tpl.preheader,
          fromName: brand?.name ?? null,
          design: design as any,
          settings: AUTOMATION_DEFAULTS[body.type] as any,
          createdBy: actor.userId ?? null,
        },
      });
    } catch (e: any) {
      if (e?.code === "P2002") {
        return this.db().emailAutomation.findFirstOrThrow({
          where: { tenantId: actor.tenantId, locationId: body.locationId, type: body.type },
        });
      }
      throw e;
    }
  }

  async update(
    actor: Actor,
    id: string,
    body: {
      subject?: string; preheader?: string | null; fromName?: string | null; replyTo?: string | null;
      design?: EmailDesign; settings?: EmailAutomationSettings; brandId?: string | null;
    },
  ) {
    const a = await this.load(actor, id);
    const data: any = {};
    if (body.subject !== undefined) data.subject = String(body.subject).slice(0, 200);
    if (body.preheader !== undefined) data.preheader = body.preheader ? String(body.preheader).slice(0, 200) : null;
    if (body.fromName !== undefined) data.fromName = body.fromName ? String(body.fromName).slice(0, 80) : null;
    if (body.replyTo !== undefined) {
      const r = body.replyTo ? normaliseEmail(body.replyTo) : null;
      if (body.replyTo && !r) throw new BadRequestException("Reply-to must be a valid email address.");
      data.replyTo = r;
    }
    if (body.design !== undefined) {
      if (!body.design || !Array.isArray((body.design as any).blocks)) throw new BadRequestException("Invalid email design.");
      if (JSON.stringify(body.design).length > 200_000) throw new BadRequestException("This email is too large.");
      data.design = body.design;
    }
    if (body.settings !== undefined) {
      const s = body.settings ?? {};
      const clamp = (v: unknown, lo: number, hi: number, d: number) => {
        const n = Math.round(Number(v));
        return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d;
      };
      data.settings =
        a.type === "WELCOME"
          ? { delayHours: clamp(s.delayHours, 0, 72, 1) }
          : { days: clamp(s.days, 7, 365, 45), cooldownDays: clamp(s.cooldownDays, 14, 365, 90) };
    }
    if (body.brandId !== undefined) {
      const { brand } = await this.svc.resolveSender(actor, body.brandId, a.locationId);
      data.brandId = brand?.id ?? null;
    }
    const saved = await this.db().emailAutomation.update({ where: { id }, data });
    // A running automation must stay sendable: an edit that breaks its offer
    // code pauses it rather than leaving it to fail on the next run.
    if (saved.enabled) {
      try {
        this.assertComplete(saved);
        await this.svc.assertOfferCodesWork(saved);
      } catch (e: any) {
        await this.svc.pauseAutomation(saved.id, `Paused: ${e?.message ?? "it can't be sent as it is"}`);
        return this.db().emailAutomation.findUniqueOrThrow({ where: { id } });
      }
    }
    return saved;
  }

  private assertComplete(a: { subject: string; design: unknown }) {
    if (!a.subject?.trim()) throw new BadRequestException("Add a subject line first.");
    const blocks = (a.design as any)?.blocks ?? [];
    if (!Array.isArray(blocks) || !blocks.length) throw new BadRequestException("The email is empty.");
  }

  async setEnabled(actor: Actor, id: string, enabled: boolean) {
    const a = await this.load(actor, id);
    if (!enabled) {
      return this.db().emailAutomation.update({ where: { id }, data: { enabled: false } });
    }
    if (!this.svc.isEnabled()) {
      throw new BadRequestException(
        "Email marketing isn't switched on for your account yet. Contact support to enable it.",
      );
    }
    this.assertComplete(a);
    await this.svc.assertOfferCodesWork(a);
    // enabledAt restarts the welcome window: switching on greets people who
    // join from now, never the whole list that joined while it was off.
    return this.db().emailAutomation.update({
      where: { id },
      data: { enabled: true, enabledAt: new Date(), lastError: null },
    });
  }

  async test(actor: Actor, id: string, to: string[]) {
    return this.svc.testSendEmail(await this.load(actor, id), to);
  }

  // ── Who is due ────────────────────────────────────────────────────────────

  private dueQuery(a: any, limit: number, now = new Date()) {
    const s = this.settingsOf(a);
    return buildAutomationQuery({
      tenantId: a.tenantId,
      automationId: a.id,
      type: a.type,
      locationId: a.locationId,
      brandId: a.brandId,
      // Not switched on yet: show who WOULD get it if switched on now.
      enabledAt: a.enabled && a.enabledAt ? a.enabledAt : now,
      delayHours: s.delayHours,
      days: s.days,
      cooldownDays: s.cooldownDays,
      limit,
      now,
    });
  }

  /** How many people the next run would email (capped for display). */
  private async dueCount(a: any): Promise<number> {
    try {
      const q = this.dueQuery(a, 5000);
      const rows = await this.svc.db().$queryRawUnsafe<any[]>(q.sql, ...q.params);
      return rows.length;
    } catch {
      return 0;
    }
  }

  // ── The run ───────────────────────────────────────────────────────────────

  @Cron("0 */15 * * * *")
  async tick(): Promise<void> {
    if (this.running || !this.svc.isEnabled()) return;
    this.running = true;
    try {
      const due = await this.db().emailAutomation.findMany({ where: { enabled: true }, take: 200 });
      for (const a of due) {
        try {
          if (!(await this.inSendHours(a.locationId))) continue;
          await this.runOne(a);
        } catch (e: any) {
          this.logger.warn(`Automation ${a.id} run failed: ${e?.message ?? e}`);
        }
      }
    } finally {
      this.running = false;
    }
  }

  private async inSendHours(locationId: string, now = new Date()): Promise<boolean> {
    const loc = await this.svc.db().location.findUnique({ where: { id: locationId }, select: { timezone: true } });
    const hour = Number(
      new Intl.DateTimeFormat("en-GB", { hour: "numeric", hourCycle: "h23", timeZone: loc?.timezone || "Europe/London" })
        .formatToParts(now)
        .find((p) => p.type === "hour")?.value ?? "12",
    );
    return hour >= SEND_FROM_HOUR && hour < SEND_UNTIL_HOUR;
  }

  /** Queue whoever is due. Returns how many were queued. */
  async runOne(a: any, now = new Date()): Promise<number> {
    try {
      this.assertComplete(a);
      await this.svc.assertOfferCodesWork(a);
    } catch (e: any) {
      await this.svc.pauseAutomation(a.id, `Paused: ${e?.message ?? "it can't be sent as it is"}`);
      return 0;
    }
    const q = this.dueQuery(a, PER_RUN, now);
    const rows = await this.svc.db().$queryRawUnsafe<{ id: string; email: string; firstName: string | null }[]>(
      q.sql,
      ...q.params,
    );
    await this.db().emailAutomation.update({ where: { id: a.id }, data: { lastRunAt: now } });
    if (!rows.length) return 0;

    const ledger = await this.ledgerFor(a);
    const created = await this.db().emailCampaignRecipient.createMany({
      data: rows.map((r) => ({
        campaignId: ledger.id,
        tenantId: a.tenantId,
        contactId: r.id,
        email: r.email,
        firstName: r.firstName ?? null,
        status: "PENDING",
      })),
      skipDuplicates: true,
    });
    if (created.count) {
      await this.db().emailCampaign.update({
        where: { id: ledger.id },
        data: { recipientCount: { increment: created.count } },
      });
      this.logger.log(`Automation ${a.type} ${a.id} queued ${created.count}`);
    }
    return created.count;
  }

  /** The ledger campaign for the automation's CURRENT email (one per version). */
  private async ledgerFor(a: any) {
    const version = createHash("sha1")
      .update(JSON.stringify([a.subject, a.preheader, a.fromName, a.replyTo, a.brandId, a.design]))
      .digest("hex")
      .slice(0, 16);
    const templateId = `auto:${version}`;
    const existing = await this.db().emailCampaign.findFirst({ where: { automationId: a.id, templateId } });
    if (existing) return existing;
    const { design } = await this.svc.withoutBrokenImages(a.design as EmailDesign);
    const ctx = await this.svc.renderContext({ ...a, design });
    const dry = renderEmail(design, { ...ctx, unsubscribeUrl: "", preheader: a.preheader });
    return this.db().emailCampaign.create({
      data: {
        tenantId: a.tenantId,
        locationId: a.locationId,
        brandId: a.brandId,
        automationId: a.id,
        templateId,
        name: `${AUTOMATION_INFO[a.type as EmailAutomationType].name} (automatic)`,
        subject: a.subject,
        preheader: a.preheader,
        fromName: a.fromName,
        replyTo: a.replyTo,
        design: design as any,
        links: dry.links as any,
        status: "AUTOMATION",
        startedAt: new Date(),
      },
    });
  }

  // ── Results ───────────────────────────────────────────────────────────────

  private async withStats(a: any) {
    const ledgers = await this.db().emailCampaign.findMany({
      where: { automationId: a.id },
      select: {
        id: true, sentCount: true, deliveredCount: true, openCount: true, clickCount: true,
        unsubscribeCount: true, bounceCount: true, complaintCount: true, chargedMinor: true, refundedMinor: true,
      },
    });
    const sum = (k: keyof (typeof ledgers)[number]) => ledgers.reduce((n, l) => n + Number(l[k] ?? 0), 0);
    const results = await this.svc.resultsMany(a.tenantId, ledgers.map((l) => l.id), a.locationId);
    return {
      ...a,
      settings: this.settingsOf(a),
      stats: {
        sent: sum("sentCount"),
        delivered: sum("deliveredCount"),
        opened: sum("openCount"),
        clicked: sum("clickCount"),
        unsubscribed: sum("unsubscribeCount"),
        bounced: sum("bounceCount"),
        complaints: sum("complaintCount"),
        chargedMinor: sum("chargedMinor") - sum("refundedMinor"),
        ...results,
      },
    };
  }
}
