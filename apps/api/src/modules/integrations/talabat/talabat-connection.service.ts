import { BadRequestException, Injectable, Logger, NotFoundException, Optional } from "@nestjs/common";
import * as crypto from "crypto";
import { PrismaService } from "../../../infrastructure/database/prisma.service";
import { ActivityLogService } from "../../logs/activity-log.service";
import { TalabatClientService, publicApiOrigin } from "./talabat-client.service";

// Phase TB-1 — one Talabat vendor ↔ one brand at one location.
//
// Delivery Hero's model (integration.talabat.com, "Setting up Integration"):
//
//   integration ─< chain ─< vendor
//
//   • Integration — us. One base URL, one credential.
//   • Chain — a restaurant brand, with a CHAIN CODE Talabat assign
//     ("yummy-ae"). Every catalog and availability call is scoped by it.
//   • Vendor — one restaurant location on Talabat. It has Talabat's VENDOR
//     CODE (the platform vendor id) and a REMOTE ID, which is "a unique
//     identifier of the vendor on your plugin" — ours to choose.
//
// We give Talabat the remote ID and they attach it to the vendor. Every order
// is POSTed to /order/{remoteId}, so the remote ID is the ONLY thing that
// routes an order to a kitchen, and it must be unique across every OrderHub
// tenant (one credential serves them all). Same model as Glovo's store id.
//
// A brand at a location is one vendor. A virtual-brand kitchen running three
// brands has three Talabat vendors and three connections here.

const REMOTE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.\-]{1,63}$/;
const CHAIN_CODE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.\-]{0,127}$/;

const minutes = (n: unknown) => {
  const v = Math.round(Number(n));
  return v >= 1 && v <= 240 ? v : null;
};

/** Stable across reconnects, short enough to read to Talabat support. */
export function defaultTalabatRemoteId(brandId: string, locationId: string): string {
  const h = crypto.createHash("sha256").update(`talabat:${brandId}:${locationId}`).digest("hex");
  return `OH-${h.slice(0, 10).toUpperCase()}`;
}

export interface TalabatConnectionSettings {
  /** Talabat's chain code — scopes catalog + availability calls. */
  chainCode?: string;
  /** Talabat's vendor code / platform restaurant id ("Platform Vendor ID"). */
  platformVendorId?: string;
  /** Global entity, e.g. "TB_AE" — required on item-availability calls. */
  globalEntityId?: string;
  /** Platform key from the availability GET, e.g. "TB". */
  platformKey?: string;
}

export interface TalabatConnectionRow {
  id: string;
  tenantId: string;
  brandId: string;
  locationId: string;
  status: string;
  externalStoreId: string | null;
  metadata: unknown;
  lastWebhookAt?: Date | null;
  lastError?: string | null;
  updatedAt?: Date;
}

/** Settings off a connection row's metadata, typed. */
export function talabatSettings(conn: { metadata: unknown }): TalabatConnectionSettings & Record<string, any> {
  return ((conn.metadata ?? {}) as any) ?? {};
}

@Injectable()
export class TalabatConnectionService {
  private readonly logger = new Logger(TalabatConnectionService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly client: TalabatClientService,
    @Optional() private readonly activity?: ActivityLogService,
  ) {}

  async connect(
    tenantId: string,
    body: {
      brandId: string;
      locationId: string;
      remoteId?: string;
      chainCode?: string;
      platformVendorId?: string;
      globalEntityId?: string;
      platformKey?: string;
      /** Used for acceptanceTime when Talabat give no time of their own. */
      defaultPrepMinutes?: number;
      defaultDeliveryMinutes?: number;
    },
  ) {
    await this.assertOwned(tenantId, body.brandId, body.locationId);

    const remoteId = (body.remoteId ?? "").trim() || defaultTalabatRemoteId(body.brandId, body.locationId);
    if (!REMOTE_ID_PATTERN.test(remoteId)) {
      throw new BadRequestException("Remote ID must be 2–64 characters: letters, numbers, dot, dash or underscore.");
    }
    const chainCode = (body.chainCode ?? "").trim();
    if (chainCode && !CHAIN_CODE_PATTERN.test(chainCode)) {
      throw new BadRequestException("Chain code may contain letters, numbers, dot, dash or underscore only.");
    }

    const clash = await this.prisma.brandPlatformConnection.findFirst({
      where: {
        platform: "TALABAT",
        externalStoreId: remoteId,
        NOT: { AND: [{ brandId: body.brandId }, { locationId: body.locationId }] },
      },
      select: { id: true },
    });
    if (clash) {
      throw new BadRequestException(
        `Remote ID "${remoteId}" is already used by another Talabat connection. ` +
          "Each Talabat vendor needs its own — Talabat route orders by it.",
      );
    }

    const existing = await this.prisma.brandPlatformConnection.findFirst({
      where: { brandId: body.brandId, locationId: body.locationId, platform: "TALABAT" },
      select: { metadata: true },
    });
    const clean = (s?: string) => (s ?? "").trim() || undefined;
    // Keep publish history / availability state across a re-save; only the
    // identifiers are being edited.
    const metadata = {
      ...((existing?.metadata as any) ?? {}),
      ...(clean(chainCode) !== undefined ? { chainCode: clean(chainCode) } : {}),
      ...(clean(body.platformVendorId) !== undefined ? { platformVendorId: clean(body.platformVendorId) } : {}),
      ...(clean(body.globalEntityId) !== undefined ? { globalEntityId: clean(body.globalEntityId)!.toUpperCase() } : {}),
      ...(clean(body.platformKey) !== undefined ? { platformKey: clean(body.platformKey) } : {}),
      ...(minutes(body.defaultPrepMinutes) ? { defaultPrepMinutes: minutes(body.defaultPrepMinutes) } : {}),
      ...(minutes(body.defaultDeliveryMinutes) ? { defaultDeliveryMinutes: minutes(body.defaultDeliveryMinutes) } : {}),
    };

    const connection = await this.prisma.brandPlatformConnection.upsert({
      where: {
        brandId_locationId_platform: { brandId: body.brandId, locationId: body.locationId, platform: "TALABAT" },
      },
      create: {
        tenantId,
        brandId: body.brandId,
        locationId: body.locationId,
        platform: "TALABAT",
        status: "connected",
        externalStoreId: remoteId,
        metadata: metadata as any,
      },
      update: { status: "connected", externalStoreId: remoteId, lastError: null, metadata: metadata as any },
    });

    // A shop already receiving Talabat through HubRise would now get every
    // order twice — once relayed (platform HUBRISE) and once direct (platform
    // TALABAT) — and the two never dedupe against each other.
    const hubrise = await this.prisma.brandPlatformConnection.findFirst({
      where: { locationId: body.locationId, platform: "HUBRISE", status: { not: "not_connected" } },
      select: { id: true },
    });

    this.activity?.record({
      tenantId,
      locationId: body.locationId,
      brandId: body.brandId,
      category: "CONNECTION",
      channel: "TALABAT",
      action: "connection.connect",
      status: hubrise ? "WARNING" : "SUCCESS",
      message:
        `Talabat connected (remote ID ${remoteId}${metadata.chainCode ? `, chain ${metadata.chainCode}` : ""})` +
        (hubrise
          ? ". This location is also on HubRise — turn Talabat off in HubRise or orders will arrive twice."
          : ""),
    });
    this.logger.log(`Talabat connected brand ${body.brandId} @ ${body.locationId} → remoteId ${remoteId}`);
    return { ...this.present(connection), hubriseWarning: !!hubrise };
  }

  async disconnect(tenantId: string, connectionId: string) {
    const conn = await this.prisma.brandPlatformConnection.findFirst({
      where: { id: connectionId, tenantId, platform: "TALABAT" },
    });
    if (!conn) throw new NotFoundException("Talabat connection not found");
    const updated = await this.prisma.brandPlatformConnection.update({
      where: { id: connectionId },
      // The remote id is dropped so orders stop routing here. The rest of the
      // metadata stays, so a reconnect remembers the chain and vendor codes.
      data: { status: "not_connected", externalStoreId: null },
    });
    this.activity?.record({
      tenantId,
      locationId: conn.locationId,
      brandId: conn.brandId,
      category: "CONNECTION",
      channel: "TALABAT",
      action: "connection.disconnect",
      status: "INFO",
      message:
        "Talabat disconnected. Orders dispatched to this remote ID will now be refused — " +
        "ask Talabat to detach it, or switch the vendor back to their tablet.",
    });
    return this.present(updated);
  }

  async list(tenantId: string, filter: { brandId?: string; locationId?: string } = {}) {
    const rows = await this.prisma.brandPlatformConnection.findMany({
      where: {
        tenantId,
        platform: "TALABAT",
        ...(filter.brandId ? { brandId: filter.brandId } : {}),
        ...(filter.locationId ? { locationId: filter.locationId } : {}),
      },
      orderBy: { updatedAt: "desc" },
    });
    return rows.map((r) => this.present(r));
  }

  /** Owned connection, or 404. Every operator route goes through this. */
  async get(tenantId: string, connectionId: string): Promise<TalabatConnectionRow> {
    const conn = await this.prisma.brandPlatformConnection.findFirst({
      where: { id: connectionId, tenantId, platform: "TALABAT" },
    });
    if (!conn) throw new NotFoundException("Talabat connection not found");
    return conn;
  }

  /** The live connection a remote id routes to — the only way an order finds a tenant. */
  async byRemoteId(remoteId: string): Promise<TalabatConnectionRow | null> {
    if (!remoteId) return null;
    return this.prisma.brandPlatformConnection.findFirst({
      where: { platform: "TALABAT", externalStoreId: remoteId, status: { not: "not_connected" } },
    });
  }

  /**
   * Everything Talabat need from us to activate the integration — their
   * "Provide following information to Talabat contact" table, filled in.
   */
  activationSheet(conns: TalabatConnectionRow[]) {
    const base = `${publicApiOrigin()}/api/v1/talabat-plugin`;
    return {
      integration: {
        name: "OrderHub UAE",
        code: "orderhub-ae",
        baseUrl: base,
        pluginUsername: process.env.TALABAT_USERNAME ? "(set)" : "(not issued yet)",
        flow: "Direct",
      },
      vendors: conns.map((c) => ({
        remoteId: c.externalStoreId,
        chainCode: talabatSettings(c).chainCode ?? null,
        vendorCode: talabatSettings(c).platformVendorId ?? null,
        flow: "Direct",
      })),
      endpoints: {
        orderDispatch: `${base}/order/{remoteId}`,
        orderStatus: `${base}/remoteId/{remoteId}/remoteOrder/{remoteOrderId}/posOrderStatus`,
        vendorAvailability: `${base}/remoteId/{remoteId}/availability`,
        menuImportTrigger: `${base}/menuimport/{remoteId}`,
      },
      // From their docs. Our plugin has to accept these.
      ipAllowlist: {
        staging: ["34.246.34.27", "18.202.142.208", "54.72.10.41"],
        middleEast: ["63.32.225.161", "18.202.96.85", "52.208.41.152"],
      },
    };
  }

  private async assertOwned(tenantId: string, brandId: string, locationId: string): Promise<void> {
    const [brand, location] = await Promise.all([
      this.prisma.brand.findFirst({ where: { id: brandId, tenantId, deletedAt: null }, select: { id: true } }),
      this.prisma.location.findFirst({
        where: { id: locationId, deletedAt: null, brand: { tenantId } },
        select: { id: true },
      }),
    ]);
    if (!brand) throw new NotFoundException("Brand not found");
    if (!location) throw new NotFoundException("Location not found");
  }

  present(conn: any) {
    const m = talabatSettings(conn);
    return {
      id: conn.id,
      brandId: conn.brandId,
      locationId: conn.locationId,
      status: conn.status,
      remoteId: conn.externalStoreId,
      chainCode: m.chainCode ?? null,
      platformVendorId: m.platformVendorId ?? null,
      globalEntityId: m.globalEntityId ?? null,
      platformKey: m.platformKey ?? null,
      defaultPrepMinutes: m.defaultPrepMinutes ?? 20,
      defaultDeliveryMinutes: m.defaultDeliveryMinutes ?? 40,
      lastWebhookAt: conn.lastWebhookAt ?? null,
      lastError: conn.lastError ?? null,
      updatedAt: conn.updatedAt ?? null,
      catalog: m.talabatCatalog ?? null,
      availability: m.talabatAvailability ?? null,
      configured: this.client.configured(),
    };
  }
}
