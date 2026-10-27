// Auto dispatch — book a third-party courier for a delivery without anyone
// pressing Dispatch.
//
// A rule picks the orders (location × brand × channel), the destination (one
// FIXED provider, or the CHEAPEST live quote from a pool) and the moment
// (on accept, on ready, or N minutes before the food is due). The cron scans
// for due orders rather than hooking every write path: an order reaches
// ACCEPTED through the till, auto-accept, four marketplace webhooks and the
// board, and a scan can't miss one of them.
//
// Booking goes through each provider's own DispatchService — the same call the
// board's Dispatch button makes — so the wallet charge, refund-on-failure and
// every provider's traps stay in one place. This service only decides.
//
// Platform-admin only for now (the controller enforces it).

import { BadRequestException, Injectable, Logger, NotFoundException, Optional } from "@nestjs/common";
import { PrismaService } from "../../infrastructure/database/prisma.service";
import { ActivityLogService } from "../logs/activity-log.service";
import { StuartDispatchService } from "../integrations/stuart/stuart-dispatch.service";
import { StuartConfigService } from "../integrations/stuart/stuart-config.service";
import { UberDirectDispatchService } from "../integrations/uber-direct/uber-direct-dispatch.service";
import { UberDirectConfigService } from "../integrations/uber-direct/uber-direct-config.service";
import { JetGoDispatchService } from "../integrations/jet-go/jet-go-dispatch.service";
import { JetGoConfigService } from "../integrations/jet-go/jet-go-config.service";
import { YangoDispatchService } from "../integrations/yango/yango-dispatch.service";
import { YangoConfigService } from "../integrations/yango/yango-config.service";
import {
  AUTO_DISPATCH_PROVIDERS,
  AutoDispatchProvider,
  NormalisedQuote,
  OrderLike,
  RuleLike,
  dueAt,
  ineligibleReason,
  pickRule,
  rankProviders,
  toMinor,
} from "./auto-dispatch.logic";

/** Orders older than this are never picked up — enabling a rule must not
 *  sweep up yesterday's forgotten tickets. */
const LOOKBACK_MS = 12 * 60 * 60 * 1000;
/** A failed attempt (no courier, all refused) is tried again this often… */
const RETRY_MS = 2 * 60 * 1000;
/** …this many times in total. */
const MAX_ATTEMPTS = 3;
/** A RUNNING row older than this belongs to a crashed tick. */
const STALE_RUNNING_MS = 5 * 60 * 1000;

const ORDER_SELECT = {
  id: true,
  tenantId: true,
  locationId: true,
  brandId: true,
  orderSource: true,
  status: true,
  fulfillmentType: true,
  deliveryType: true,
  courierJobId: true,
  acceptedAt: true,
  readyAt: true,
  estimatedReadyAt: true,
  preparationMinutes: true,
  scheduledFor: true,
  createdAt: true,
  displayId: true,
  orderNumber: true,
  customerName: true,
  total: true,
} as const;

export interface RuleInput {
  name: string;
  enabled?: boolean;
  priority?: number;
  locationId?: string | null;
  brandIds?: string[];
  channels?: string[];
  strategy: string;
  providers: string[];
  fallback?: boolean;
  trigger: string;
  delayMinutes?: number;
  maxPriceMinor?: number | null;
  dryRun?: boolean;
}

@Injectable()
export class AutoDispatchService {
  private readonly logger = new Logger(AutoDispatchService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly stuart: StuartDispatchService,
    private readonly stuartConfig: StuartConfigService,
    private readonly uber: UberDirectDispatchService,
    private readonly uberConfig: UberDirectConfigService,
    private readonly jetGo: JetGoDispatchService,
    private readonly jetGoConfig: JetGoConfigService,
    private readonly yango: YangoDispatchService,
    private readonly yangoConfig: YangoConfigService,
    @Optional() private readonly activity?: ActivityLogService,
  ) {}

  private db(): any {
    return this.prisma as any;
  }

  // ── Rules CRUD ────────────────────────────────────────────────────────────

  listRules(tenantId: string) {
    return this.db().autoDispatchRule.findMany({
      where: { tenantId },
      orderBy: [{ priority: "asc" }, { createdAt: "asc" }],
    });
  }

  private async clean(tenantId: string, input: Partial<RuleInput>) {
    const out: Record<string, unknown> = {};
    if (input.name !== undefined) {
      const name = String(input.name).trim();
      if (!name) throw new BadRequestException("Give the rule a name.");
      out.name = name.slice(0, 80);
    }
    if (input.strategy !== undefined) {
      if (!["FIXED", "CHEAPEST"].includes(input.strategy)) {
        throw new BadRequestException("Strategy must be FIXED or CHEAPEST.");
      }
      out.strategy = input.strategy;
    }
    if (input.trigger !== undefined) {
      if (!["ON_ACCEPT", "ON_READY", "BEFORE_READY"].includes(input.trigger)) {
        throw new BadRequestException("Unknown trigger.");
      }
      out.trigger = input.trigger;
    }
    if (input.providers !== undefined) {
      const providers = [...new Set(input.providers)].filter((p) =>
        (AUTO_DISPATCH_PROVIDERS as readonly string[]).includes(p),
      );
      if (!providers.length) throw new BadRequestException("Pick at least one courier provider.");
      out.providers = providers;
    }
    if (input.locationId !== undefined) {
      if (input.locationId) {
        const loc = await this.db().location.findFirst({
          where: { id: input.locationId, deletedAt: null, brand: { tenantId } },
          select: { id: true },
        });
        if (!loc) throw new BadRequestException("That location isn't on this tenant.");
      }
      out.locationId = input.locationId || null;
    }
    if (input.brandIds !== undefined) {
      const ids = [...new Set(input.brandIds.filter(Boolean))];
      if (ids.length) {
        const found = await this.db().brand.count({ where: { id: { in: ids }, tenantId } });
        if (found !== ids.length) throw new BadRequestException("A brand isn't on this tenant.");
      }
      out.brandIds = ids;
    }
    if (input.channels !== undefined) out.channels = [...new Set(input.channels.filter(Boolean))];
    if (input.priority !== undefined) out.priority = Math.trunc(Number(input.priority) || 0);
    if (input.fallback !== undefined) out.fallback = Boolean(input.fallback);
    if (input.dryRun !== undefined) out.dryRun = Boolean(input.dryRun);
    if (input.delayMinutes !== undefined) {
      out.delayMinutes = Math.min(Math.max(Math.trunc(Number(input.delayMinutes) || 0), 0), 240);
    }
    if (input.maxPriceMinor !== undefined) {
      const n = input.maxPriceMinor == null ? null : Math.trunc(Number(input.maxPriceMinor));
      out.maxPriceMinor = n != null && Number.isFinite(n) && n > 0 ? n : null;
    }
    return out;
  }

  /** A rule scoped to one location may only name brands that trade there —
   *  any other brand could never match, and the rule would silently do
   *  nothing. */
  private async assertBrandsAtLocation(
    tenantId: string,
    locationId: string | null | undefined,
    brandIds: string[] | undefined,
  ) {
    if (!locationId || !brandIds?.length) return;
    const at = (await this.brandsByLocation(tenantId, [locationId])).get(locationId) ?? new Set();
    if (brandIds.some((b) => !at.has(b))) {
      throw new BadRequestException("A selected brand doesn't trade at that location.");
    }
  }

  async createRule(tenantId: string, userId: string | null, input: RuleInput) {
    const data = await this.clean(tenantId, input);
    await this.assertBrandsAtLocation(
      tenantId,
      data.locationId as string | null,
      data.brandIds as string[] | undefined,
    );
    const enabled = Boolean(input.enabled);
    return this.db().autoDispatchRule.create({
      data: {
        ...data,
        tenantId,
        enabled,
        enabledAt: enabled ? new Date() : null,
        createdBy: userId,
      },
    });
  }

  async updateRule(tenantId: string, id: string, input: Partial<RuleInput>) {
    const existing = await this.db().autoDispatchRule.findFirst({ where: { id, tenantId } });
    if (!existing) throw new NotFoundException("Rule not found");
    const data = await this.clean(tenantId, input);
    if (data.locationId !== undefined || data.brandIds !== undefined) {
      await this.assertBrandsAtLocation(
        tenantId,
        (data.locationId !== undefined ? data.locationId : existing.locationId) as string | null,
        (data.brandIds ?? existing.brandIds) as string[],
      );
    }
    if (input.enabled !== undefined) {
      data.enabled = Boolean(input.enabled);
      // Restart the clock on every switch-on, so turning a rule off and on
      // again doesn't pick up what piled up while it was off.
      if (data.enabled && !existing.enabled) data.enabledAt = new Date();
    }
    return this.db().autoDispatchRule.update({ where: { id }, data });
  }

  async deleteRule(tenantId: string, id: string) {
    const res = await this.db().autoDispatchRule.deleteMany({ where: { id, tenantId } });
    if (!res.count) throw new NotFoundException("Rule not found");
    // Anything still waiting on this rule would otherwise fire after delete.
    await this.db().autoDispatchRun.updateMany({
      where: { ruleId: id, status: "SCHEDULED" },
      data: { status: "SKIPPED", error: "Rule deleted", finishedAt: new Date() },
    });
    return { ok: true };
  }

  // ── Options for the rule editor ───────────────────────────────────────────

  async options(tenantId: string) {
    const locations = await this.db().location.findMany({
      where: { deletedAt: null, brand: { tenantId } },
      select: { id: true, name: true, country: true, currency: true },
      orderBy: { name: "asc" },
    });
    const brands = await this.db().brand.findMany({
      where: { tenantId, deletedAt: null },
      select: { id: true, name: true },
      orderBy: { name: "asc" },
    });
    const brandsAt = await this.brandsByLocation(
      tenantId,
      locations.map((l: any) => l.id),
    );
    const withProviders = await Promise.all(
      locations.map(async (l: any) => ({
        ...l,
        brandIds: [...(brandsAt.get(l.id) ?? [])],
        providers: await this.readiness(l.id),
      })),
    );
    return {
      locations: withProviders,
      brands,
      channels: [
        "DIRECT", "ONLINE", "POS", "VOICE", "WHATSAPP", "JUST_EAT", "UBER_EATS",
        "DELIVEROO", "HUBRISE", "TALABAT", "CAREEM", "GLOVO", "KEETA", "EAT_FOR_LESS",
      ],
      providers: AUTO_DISPATCH_PROVIDERS,
    };
  }

  /**
   * The brands that trade at each location. A brand counts when it is the
   * location's own brand or lives there (primaryLocationId) — the same test
   * the storefront uses — or when a multi-brand kitchen serves its menu there
   * (MenuChannelAssignment), or it has taken orders there in the last 60 days
   * (marketplace brands that arrive through HubRise with no menu of ours).
   */
  private async brandsByLocation(tenantId: string, locationIds: string[]) {
    const out = new Map<string, Set<string>>();
    const add = (loc: string | null | undefined, brand: string | null | undefined) => {
      if (!loc || !brand) return;
      if (!out.has(loc)) out.set(loc, new Set());
      out.get(loc)!.add(brand);
    };
    if (!locationIds.length) return out;
    const [locs, homed, served, ordered] = await Promise.all([
      this.db().location.findMany({
        where: { id: { in: locationIds } },
        select: { id: true, brandId: true },
      }),
      this.db().brand.findMany({
        where: { tenantId, deletedAt: null, primaryLocationId: { in: locationIds } },
        select: { id: true, primaryLocationId: true },
      }),
      this.db().menuChannelAssignment.findMany({
        where: { locationId: { in: locationIds } },
        select: { locationId: true, brandId: true },
        distinct: ["locationId", "brandId"],
      }),
      this.db().order.groupBy({
        by: ["locationId", "brandId"],
        where: {
          tenantId,
          locationId: { in: locationIds },
          brandId: { not: null },
          createdAt: { gte: new Date(Date.now() - 60 * 24 * 60 * 60 * 1000) },
        },
      }),
    ]);
    for (const l of locs) add(l.id, l.brandId);
    for (const b of homed) add(b.primaryLocationId, b.id);
    for (const a of served) add(a.locationId, a.brandId);
    for (const o of ordered) add(o.locationId, o.brandId);
    return out;
  }

  /** Which providers can actually book from this location right now. */
  private async readiness(locationId: string): Promise<Record<AutoDispatchProvider, string>> {
    const safe = async (fn: () => Promise<string>) => {
      try {
        return await fn();
      } catch {
        return "error";
      }
    };
    const [STUART, UBER_DIRECT, JET_GO, YANGO] = await Promise.all([
      safe(async () => {
        const c = await this.stuartConfig.getDecrypted(locationId);
        return !c ? "not_set_up" : c.active ? "ready" : "off";
      }),
      safe(async () => {
        const c = await this.uberConfig.getDecrypted(locationId);
        return !c ? "not_set_up" : c.active ? "ready" : "off";
      }),
      safe(async () => {
        const c = await this.jetGoConfig.getDecrypted(locationId);
        if (!c) return "not_set_up";
        if (!c.active) return "off";
        return c.collectPointId ? "ready" : "no_collect_point";
      }),
      safe(async () => {
        const c = await this.yangoConfig.getDecrypted(locationId);
        if (!c?.token) return "not_set_up";
        if (!c.active) return "off";
        return c.mode === "live" ? "ready" : "estimate_only";
      }),
    ]);
    return { STUART, UBER_DIRECT, JET_GO, YANGO };
  }

  // ── Quotes ────────────────────────────────────────────────────────────────

  private async quoteOne(
    provider: AutoDispatchProvider,
    orderId: string,
    tenantId: string,
  ): Promise<NormalisedQuote> {
    try {
      const q: any =
        provider === "STUART"
          ? await this.stuart.quote({ orderId, tenantId })
          : provider === "UBER_DIRECT"
            ? await this.uber.quote({ orderId, tenantId })
            : provider === "JET_GO"
              ? await this.jetGo.quote({ orderId, tenantId })
              : await this.yango.quote({ orderId, tenantId });
      const amountMinor = toMinor(q?.amount);
      return {
        provider,
        ok: amountMinor != null,
        amountMinor,
        currency: q?.currency ?? null,
        canDispatch: q?.canDispatch !== false,
        deliverBy: q?.deliverBy ?? (q?.etaMinutes != null ? `${q.etaMinutes} min` : null),
        error: amountMinor == null ? "No price returned" : null,
      };
    } catch (err: any) {
      return {
        provider,
        ok: false,
        amountMinor: null,
        currency: null,
        canDispatch: false,
        error: String(err?.response?.message ?? err?.message ?? err).slice(0, 300),
      };
    }
  }

  /** Every provider in parallel. They are independent networks; quoting one
   *  after another would make "cheapest" cost the customer half a minute. */
  quoteAll(providers: AutoDispatchProvider[], orderId: string, tenantId: string) {
    return Promise.all(providers.map((p) => this.quoteOne(p, orderId, tenantId)));
  }

  /** The admin "live quote" tester: every provider for one order, plus which
   *  rule would take it and what it would choose. Books nothing. */
  async preview(tenantId: string, orderId: string) {
    const order = await this.db().order.findFirst({
      where: { id: orderId, tenantId },
      select: ORDER_SELECT,
    });
    if (!order) throw new NotFoundException("Order not found");
    const rules = await this.listRules(tenantId);
    const rule: any = pickRule(rules as RuleLike[], order as OrderLike);
    const quotes = await this.quoteAll([...AUTO_DISPATCH_PROVIDERS], orderId, tenantId);
    const ranked = rule
      ? rankProviders(rule, quotes.filter((q) => rule.providers.includes(q.provider)))
      : [];
    return {
      order,
      ineligible: ineligibleReason(order as OrderLike),
      rule: rule ? { id: rule.id, name: rule.name, strategy: rule.strategy } : null,
      dueAt: rule ? dueAt(rule, order as OrderLike) : null,
      quotes,
      wouldChoose: ranked[0] ?? null,
      tryOrder: ranked,
    };
  }

  /** Recent delivery orders, for the tester's picker. */
  recentOrders(tenantId: string) {
    return this.db().order.findMany({
      where: {
        tenantId,
        fulfillmentType: { in: ["DELIVERY", "MERCHANT_DELIVERY"] },
        createdAt: { gte: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000) },
      },
      select: { ...ORDER_SELECT, location: { select: { name: true } } },
      orderBy: { createdAt: "desc" },
      take: 40,
    });
  }

  listRuns(tenantId: string, limit = 50) {
    return this.db().autoDispatchRun.findMany({
      where: { tenantId },
      orderBy: { createdAt: "desc" },
      take: Math.min(Math.max(limit, 1), 200),
    });
  }

  // ── The engine (called by the cron) ───────────────────────────────────────

  /** One pass: schedule newly matching orders, then run whatever is due. */
  async tick(now = new Date()) {
    await this.reclaimStale(now);
    const scheduled = await this.scheduleNew(now);
    const ran = await this.runDue(now);
    return { scheduled, ran };
  }

  /** A tick that died mid-run leaves RUNNING behind. Put it back only when no
   *  courier was booked — the order row is the truth for that. */
  private async reclaimStale(now: Date) {
    const stale = await this.db().autoDispatchRun.findMany({
      where: { status: "RUNNING", updatedAt: { lt: new Date(now.getTime() - STALE_RUNNING_MS) } },
      take: 50,
    });
    for (const run of stale) {
      const order = await this.db().order.findUnique({
        where: { id: run.orderId },
        select: { courierJobId: true, courierProvider: true },
      });
      await this.db().autoDispatchRun.update({
        where: { id: run.id },
        data: order?.courierJobId
          ? {
              status: "DISPATCHED",
              provider: order.courierProvider,
              jobId: order.courierJobId,
              finishedAt: now,
            }
          : { status: "SCHEDULED", dueAt: now },
      });
    }
  }

  private async scheduleNew(now: Date): Promise<number> {
    const rules: any[] = await this.db().autoDispatchRule.findMany({ where: { enabled: true } });
    if (!rules.length) return 0;
    const byTenant = new Map<string, any[]>();
    for (const r of rules) byTenant.set(r.tenantId, [...(byTenant.get(r.tenantId) ?? []), r]);

    let created = 0;
    for (const [tenantId, tenantRules] of byTenant) {
      const locationIds = tenantRules.some((r) => !r.locationId)
        ? undefined
        : [...new Set(tenantRules.map((r) => r.locationId))];
      const orders: any[] = await this.db().order.findMany({
        where: {
          tenantId,
          ...(locationIds ? { locationId: { in: locationIds } } : {}),
          status: { in: ["ACCEPTED", "PREPARING", "READY"] },
          fulfillmentType: { in: ["DELIVERY", "MERCHANT_DELIVERY"] },
          courierJobId: null,
          createdAt: { gte: new Date(now.getTime() - LOOKBACK_MS) },
        },
        select: { ...ORDER_SELECT, driverAssignment: { select: { status: true } } },
        take: 500,
      });
      if (!orders.length) continue;
      const seen = new Set(
        (
          await this.db().autoDispatchRun.findMany({
            where: { orderId: { in: orders.map((o) => o.id) } },
            select: { orderId: true },
          })
        ).map((r: any) => r.orderId),
      );
      const prepByLocation = new Map<string, number | null>();

      for (const o of orders) {
        if (seen.has(o.id)) continue;
        if (ineligibleReason(o)) continue;
        // Our own fleet has it — not ours to override.
        if (o.driverAssignment && o.driverAssignment.status !== "CANCELLED") continue;
        const rule = pickRule(tenantRules, o);
        if (!rule) continue;
        // ON_READY waits for the event; nothing to schedule yet.
        if (!prepByLocation.has(o.locationId)) {
          const loc = await this.db().location.findUnique({
            where: { id: o.locationId },
            select: { prepTime: true },
          });
          prepByLocation.set(o.locationId, loc?.prepTime ?? null);
        }
        const due = dueAt(rule, o, prepByLocation.get(o.locationId));
        if (!due) continue;
        try {
          // The unique orderId makes this insert the claim. A second instance
          // racing us gets P2002 and moves on.
          await this.db().autoDispatchRun.create({
            data: { tenantId, orderId: o.id, locationId: o.locationId, ruleId: rule.id, dueAt: due },
          });
          created++;
        } catch (err: any) {
          if (err?.code !== "P2002") throw err;
        }
      }
    }
    return created;
  }

  private async runDue(now: Date): Promise<number> {
    const due: any[] = await this.db().autoDispatchRun.findMany({
      where: { status: "SCHEDULED", dueAt: { lte: now } },
      orderBy: { dueAt: "asc" },
      take: 25,
    });
    let ran = 0;
    for (const run of due) {
      // Compare-and-set: only the tick that flips SCHEDULED → RUNNING books.
      const claim = await this.db().autoDispatchRun.updateMany({
        where: { id: run.id, status: "SCHEDULED" },
        data: { status: "RUNNING", attempts: { increment: 1 } },
      });
      if (!claim.count) continue;
      ran++;
      try {
        await this.execute({ ...run, attempts: run.attempts + 1 });
      } catch (err: any) {
        this.logger.error(`Auto dispatch run ${run.id} crashed: ${err?.message ?? err}`);
        await this.finish(run, "FAILED", { error: String(err?.message ?? err).slice(0, 500) });
      }
    }
    return ran;
  }

  private async finish(run: any, status: string, data: Record<string, unknown> = {}) {
    await this.db().autoDispatchRun.update({
      where: { id: run.id },
      data: { status, finishedAt: new Date(), ...data },
    });
  }

  private async execute(run: any) {
    const rule = await this.db().autoDispatchRule.findUnique({ where: { id: run.ruleId } });
    if (!rule || !rule.enabled) {
      return this.finish(run, "SKIPPED", { error: rule ? "Rule switched off" : "Rule deleted" });
    }
    // Re-read the order: between scheduling and now an operator may have
    // dispatched it by hand, given it to a driver, or cancelled it.
    const order = await this.db().order.findUnique({
      where: { id: run.orderId },
      select: { ...ORDER_SELECT, driverAssignment: { select: { status: true } } },
    });
    const why = !order
      ? "Order gone"
      : ineligibleReason(order) ??
        (order.driverAssignment && order.driverAssignment.status !== "CANCELLED"
          ? "Given to own fleet"
          : null);
    if (why) return this.finish(run, "SKIPPED", { error: why });

    const pool = (rule.providers as string[]).filter((p): p is AutoDispatchProvider =>
      (AUTO_DISPATCH_PROVIDERS as readonly string[]).includes(p),
    );
    // CHEAPEST needs every price. FIXED books straight away and only prices
    // when it has a cap to check against.
    const quotes =
      rule.strategy === "CHEAPEST" || rule.maxPriceMinor != null
        ? await this.quoteAll(pool, order.id, order.tenantId)
        : [];
    const tries = rankProviders(rule, quotes);
    const ref = order.displayId ?? (order.orderNumber != null ? `#${order.orderNumber}` : order.id.slice(-6));

    if (!tries.length) {
      return this.retryOrFail(run, order, {
        quotes,
        error:
          rule.maxPriceMinor != null && quotes.some((q) => q.ok)
            ? `Every quote was above the £${(rule.maxPriceMinor / 100).toFixed(2)} cap`
            : "No provider could take this delivery",
      }, ref);
    }

    if (rule.dryRun) {
      const pick = quotes.find((q) => q.provider === tries[0]);
      await this.finish(run, "DRY_RUN", {
        quotes,
        provider: tries[0],
        priceMinor: pick?.amountMinor ?? null,
      });
      this.log(order, "INFO", `Auto dispatch (dry run) would send ${ref} to ${tries[0]}`, { quotes });
      return;
    }

    const errors: string[] = [];
    for (const provider of tries) {
      try {
        const res: any = await this.book(provider, order.id, order.tenantId);
        const pick = quotes.find((q) => q.provider === provider);
        await this.finish(run, "DISPATCHED", {
          quotes,
          provider,
          jobId: res?.jobId != null ? String(res.jobId) : null,
          priceMinor: pick?.amountMinor ?? res?.courierFeeMinor ?? null,
          error: errors.length ? errors.join(" · ").slice(0, 500) : null,
        });
        this.log(order, "SUCCESS", `Auto dispatch sent ${ref} to ${provider}`, {
          rule: rule.name,
          strategy: rule.strategy,
          quotes,
          skipped: errors,
        });
        return;
      } catch (err: any) {
        const msg = String(err?.response?.message ?? err?.message ?? err);
        errors.push(`${provider}: ${msg}`);
        this.logger.warn(`Auto dispatch ${provider} refused order ${order.id}: ${msg}`);
      }
    }
    return this.retryOrFail(run, order, { quotes, error: errors.join(" · ").slice(0, 500) }, ref);
  }

  private async retryOrFail(run: any, order: any, data: { quotes: NormalisedQuote[]; error: string }, ref: string) {
    if (run.attempts < MAX_ATTEMPTS) {
      await this.db().autoDispatchRun.update({
        where: { id: run.id },
        data: { status: "SCHEDULED", dueAt: new Date(Date.now() + RETRY_MS), ...data },
      });
      return;
    }
    await this.finish(run, "FAILED", data);
    this.log(order, "ERROR", `Auto dispatch gave up on ${ref} — dispatch it by hand`, data);
  }

  private book(provider: AutoDispatchProvider, orderId: string, tenantId: string) {
    // userId null: the wallet ledger shows the system booked it, not a person.
    const args = { orderId, tenantId, userId: null };
    switch (provider) {
      case "STUART":
        return this.stuart.dispatch(args);
      case "UBER_DIRECT":
        return this.uber.dispatch(args);
      case "JET_GO":
        return this.jetGo.dispatch(args);
      case "YANGO":
        // Never the admin bypass: an automatic booking is paid for like any other.
        return this.yango.dispatch({ ...args, isAdmin: false });
    }
  }

  private log(order: any, status: "SUCCESS" | "ERROR" | "INFO", message: string, details: Record<string, unknown>) {
    this.activity?.record({
      tenantId: order.tenantId,
      locationId: order.locationId,
      brandId: order.brandId ?? null,
      category: "ORDERS",
      channel: "AUTO_DISPATCH",
      action: "courier.auto_dispatch",
      status,
      message,
      details: { orderId: order.id, ...details },
    });
  }
}
