import { Injectable, Logger, NotFoundException, Optional } from "@nestjs/common";
import { PrismaService } from "../../../infrastructure/database/prisma.service";
import { hoursConfigured, toWeekHours } from "../../../common/opening-hours.util";
import { ActivityLogService } from "../../logs/activity-log.service";
import { KeetaAuthService } from "./keeta-auth.service";
import { KeetaApiError, KeetaClientService } from "./keeta-client.service";
import { kInt, keetaId } from "./keeta-json";
import { KEETA_ALL_WEEK_OPEN, keetaBusinessHours } from "./keeta-hours";

// Phase KT-5 — store open/closed and opening hours on Keeta.
//
//   /scm/shop/status/rest   suspend (status 4)
//   /scm/shop/status/open   reopen  (status 3)
//
// Both act on delivery AND pickup together — "You cannot independently
// suspend or reactivate just one service line through the API". There is no
// timed suspension either: a timed pause here closes the store and our pause
// expiry (via PauseService) reopens it.
//
// Keeta themselves can suspend a store — for weather ("typhoons, black
// rainstorms"), or as a PENALTY for letting orders time out unconfirmed — and
// only Keeta can lift that. Webhook 1102 tells us; it is recorded on the
// connection so "why is Keeta closed?" has an answer on our side.

@Injectable()
export class KeetaStoreService {
  private readonly logger = new Logger(KeetaStoreService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly client: KeetaClientService,
    private readonly auth: KeetaAuthService,
    @Optional() private readonly activity?: ActivityLogService,
  ) {}

  private async conn(tenantId: string, connectionId: string) {
    const c = await this.prisma.brandPlatformConnection.findFirst({
      where: { id: connectionId, tenantId, platform: "KEETA" },
    });
    if (!c?.externalStoreId) throw new NotFoundException("Keeta connection not found");
    return c;
  }

  async setOpen(tenantId: string, connectionId: string, open: boolean) {
    const c = await this.conn(tenantId, connectionId);
    await this.apply(c, open);
    return { ok: true, open };
  }

  /** PauseService hook: mirror our pause state for one brand at one location. */
  async reconcile(args: { tenantId: string; brandId: string; locationId: string; paused: boolean }) {
    if (!this.client.configured) return;
    const c = await this.prisma.brandPlatformConnection.findFirst({
      where: {
        tenantId: args.tenantId,
        brandId: args.brandId,
        locationId: args.locationId,
        platform: "KEETA",
        status: { in: ["connected", "suspended"] },
        externalStoreId: { not: null },
      },
    });
    if (!c) return;
    await this.apply(c, !args.paused);
  }

  private async apply(c: any, open: boolean) {
    const token = await this.auth.tokenForConnection(c);
    const log = {
      tenantId: c.tenantId,
      brandId: c.brandId,
      locationId: c.locationId,
      category: "STATUS" as const,
      channel: "KEETA",
      action: open ? "store.resume" : "store.pause",
    };
    try {
      await this.client.request(
        open ? "/scm/shop/status/open" : "/scm/shop/status/rest",
        { shopId: kInt(c.externalStoreId) },
        { accessToken: token, retries: 1 },
      );
    } catch (e: any) {
      const msg = e instanceof KeetaApiError ? `${e.keetaCode}: ${e.keetaMessage}` : String(e?.message ?? e);
      this.activity?.record({
        ...log,
        status: "ERROR",
        message:
          `Keeta store ${c.externalStoreId} could not be ${open ? "reopened" : "paused"}: ${msg}` +
          (open ? ". If Keeta suspended it (weather, or missed orders), only Keeta can reopen it." : ""),
      });
      throw e;
    }
    await this.prisma.brandPlatformConnection
      .update({ where: { id: c.id }, data: { status: open ? "connected" : "suspended" } })
      .catch(() => undefined);
    this.activity?.record({
      ...log,
      status: "SUCCESS",
      message: `Keeta store ${c.externalStoreId} ${open ? "reopened" : "paused"}`,
    });
  }

  /**
   * Publish the location's opening hours (brand hours as the fallback — the
   * same precedence every other channel uses).
   */
  async publishHours(tenantId: string, connectionId: string) {
    const c = await this.conn(tenantId, connectionId);
    const location = await this.prisma.location.findFirst({
      where: { id: c.locationId, deletedAt: null, brand: { tenantId } },
      select: { openingHours: true, brand: { select: { openingHours: true } } },
    });
    if (!location) throw new NotFoundException("Location not found");
    const raw = hoursConfigured(location.openingHours)
      ? location.openingHours
      : (location.brand as { openingHours: unknown } | null)?.openingHours;
    // No hours anywhere = open, as the till treats it. Publishing a closed
    // week would make Keeta the one place this shop is shut.
    const configured = hoursConfigured(raw);
    const businessHourOfTheWeek = configured ? keetaBusinessHours(toWeekHours(raw)) : KEETA_ALL_WEEK_OPEN;

    const token = await this.auth.tokenForConnection(c);
    await this.client.request(
      "/scm/shop/business/hour/effective/update",
      { shopId: kInt(c.externalStoreId!), businessHourOfTheWeek },
      { accessToken: token },
    );
    this.activity?.record({
      tenantId,
      brandId: c.brandId,
      locationId: c.locationId,
      category: "STATUS",
      channel: "KEETA",
      action: "store.hours",
      status: "SUCCESS",
      message: configured
        ? `Opening hours published to Keeta store ${c.externalStoreId}`
        : `No opening hours set — Keeta store ${c.externalStoreId} published as open all week. Set real hours before going live.`,
    });
    return { ok: true, configured, businessHourOfTheWeek };
  }

  /** What Keeta think: store details, including whether it can take orders now. */
  async details(tenantId: string, connectionId: string) {
    const c = await this.conn(tenantId, connectionId);
    const token = await this.auth.tokenForConnection(c);
    const [base, hours] = await Promise.all([
      this.client.request<any>("/scm/shop/base/get", { shopId: kInt(c.externalStoreId!) }, { accessToken: token }),
      this.client
        .request<any>("/scm/shop/business/hour/effective/get", { shopId: kInt(c.externalStoreId!) }, { accessToken: token })
        .catch(() => null),
    ]);
    return { store: base, hours };
  }

  /** 1102 — Keeta changed the store's status (possibly on their own). */
  async onStoreStatus(msg: Record<string, any>) {
    const shopId = keetaId(msg.shopId);
    if (!shopId) return;
    const conns = await this.prisma.brandPlatformConnection.findMany({
      where: { platform: "KEETA", externalStoreId: shopId },
      select: { id: true, tenantId: true, brandId: true, locationId: true, metadata: true },
    });
    const open = Number(msg.toStatus) === 3;
    for (const c of conns) {
      const metadata = {
        ...((c.metadata as any) ?? {}),
        keetaStoreStatus: {
          status: msg.toStatus ?? null,
          deliveryRestStatus: msg.toDeliveryRestStatus ?? null,
          pickupRestStatus: msg.toPickupRestStatus ?? null,
          at: new Date().toISOString(),
        },
      };
      await this.prisma.brandPlatformConnection
        .update({ where: { id: c.id }, data: { metadata: metadata as any } })
        .catch(() => undefined);
      if (Number(msg.fromStatus) !== Number(msg.toStatus)) {
        this.activity?.record({
          tenantId: c.tenantId,
          brandId: c.brandId,
          locationId: c.locationId,
          category: "STATUS",
          channel: "KEETA",
          action: open ? "store.opened_by_keeta" : "store.closed_by_keeta",
          status: open ? "INFO" : "WARNING",
          message: open
            ? `Keeta store ${shopId} is open for orders`
            : `Keeta store ${shopId} is now CLOSED on Keeta. If nobody here paused it, Keeta did — ` +
              `often for missed orders or weather. Only Keeta can lift their own suspension.`,
        });
      }
    }
  }

  /** 1101 — hours changed (maybe in the Keeta merchant app). Logged only. */
  async onHoursChanged(msg: Record<string, any>) {
    this.logger.log(`Keeta store ${keetaId(msg.shopId)} hours changed on Keeta's side`);
  }
}
