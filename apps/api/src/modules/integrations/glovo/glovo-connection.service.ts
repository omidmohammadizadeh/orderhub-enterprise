import { BadRequestException, Injectable, Logger, NotFoundException, Optional } from "@nestjs/common";
import * as crypto from "crypto";
import { PrismaService } from "../../../infrastructure/database/prisma.service";
import { ActivityLogService } from "../../logs/activity-log.service";
import { GlovoClientService } from "./glovo-client.service";

// Phase GL-6 — per-brand, per-location Glovo connection.
//
// Connecting is a form, and a short one. Glovo's model: "For every store
// address you will need to establish a unique identifier also known as store
// id or external id… This Store ID is the one provided by you." So WE choose
// the store id and hand it to Glovo's onboarding team, who attach it to the
// store address on their side. Every order, and every call we make, carries it.
//
// There is one token for the whole integration (all tenants), so the store id
// must be unique across EVERY OrderHub connection, not just this tenant's —
// it is the only thing that routes an order to a kitchen. A clash is refused
// here rather than discovered as a misrouted order.
//
// The default is derived from the brand + location ids so it is stable (a
// reconnect gets the same id Glovo already has on file) and short enough to
// read out over the phone to Glovo support.

const STORE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.\-]{1,63}$/;

export function defaultGlovoStoreId(brandId: string, locationId: string): string {
  const h = crypto.createHash("sha256").update(`${brandId}:${locationId}`).digest("hex");
  return `OH-${h.slice(0, 10).toUpperCase()}`;
}

@Injectable()
export class GlovoConnectionService {
  private readonly logger = new Logger(GlovoConnectionService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly client: GlovoClientService,
    @Optional() private readonly activity?: ActivityLogService,
  ) {}

  async connect(
    tenantId: string,
    body: { brandId: string; locationId: string; storeId?: string },
  ) {
    await this.assertOwned(tenantId, body.brandId, body.locationId);

    const storeId = (body.storeId ?? "").trim() || defaultGlovoStoreId(body.brandId, body.locationId);
    if (!STORE_ID_PATTERN.test(storeId)) {
      throw new BadRequestException(
        "Store ID must be 2–64 characters: letters, numbers, dot, dash or underscore.",
      );
    }

    const clash = await this.prisma.brandPlatformConnection.findFirst({
      where: {
        platform: "GLOVO",
        externalStoreId: storeId,
        NOT: { AND: [{ brandId: body.brandId }, { locationId: body.locationId }] },
      },
      select: { id: true },
    });
    if (clash) {
      throw new BadRequestException(
        `Store ID "${storeId}" is already used by another Glovo connection. ` +
          `Each store address needs its own — Glovo routes orders by it.`,
      );
    }

    const existing = await this.prisma.brandPlatformConnection.findFirst({
      where: { brandId: body.brandId, locationId: body.locationId, platform: "GLOVO" },
      select: { metadata: true },
    });
    // Keep the menu-publish history (and its daily upload count) across a
    // re-save; only the store id is being edited.
    const metadata = { ...((existing?.metadata as any) ?? {}), storeId };

    const connection = await this.prisma.brandPlatformConnection.upsert({
      where: {
        brandId_locationId_platform: {
          brandId: body.brandId,
          locationId: body.locationId,
          platform: "GLOVO",
        },
      },
      create: {
        tenantId,
        brandId: body.brandId,
        locationId: body.locationId,
        platform: "GLOVO",
        status: "connected",
        externalStoreId: storeId,
        metadata: metadata as any,
      },
      update: {
        status: "connected",
        externalStoreId: storeId,
        lastError: null,
        metadata: metadata as any,
      },
    });

    this.activity?.record({
      tenantId,
      locationId: body.locationId,
      brandId: body.brandId,
      category: "CONNECTION",
      channel: "GLOVO",
      action: "connection.connect",
      status: "SUCCESS",
      message: `Glovo connected (store ID ${storeId})`,
    });
    this.logger.log(`Glovo connected brand ${body.brandId} @ ${body.locationId} → store ${storeId}`);
    return this.present(connection);
  }

  async disconnect(tenantId: string, connectionId: string) {
    const conn = await this.prisma.brandPlatformConnection.findFirst({
      where: { id: connectionId, tenantId, platform: "GLOVO" },
    });
    if (!conn) throw new NotFoundException("Glovo connection not found");

    // Drop the store id so orders stop routing here, and kill the menu feed
    // URL: a disconnected store should not keep serving its menu.
    const metadata = { ...((conn.metadata as any) ?? {}) };
    if (metadata.glovoMenuPublish) {
      metadata.glovoMenuPublish = { ...metadata.glovoMenuPublish, feedToken: null };
    }
    const updated = await this.prisma.brandPlatformConnection.update({
      where: { id: connectionId },
      data: { status: "not_connected", externalStoreId: null, metadata: metadata as any },
    });
    this.activity?.record({
      tenantId,
      locationId: conn.locationId,
      brandId: conn.brandId,
      category: "CONNECTION",
      channel: "GLOVO",
      action: "connection.disconnect",
      status: "INFO",
      message:
        "Glovo disconnected. Orders will stop reaching the board; ask Glovo to detach the store ID too, " +
        "or they keep arriving on the Glovo Partner Webapp only.",
    });
    return this.present(updated);
  }

  async list(tenantId: string, brandId?: string) {
    const rows = await this.prisma.brandPlatformConnection.findMany({
      where: { tenantId, platform: "GLOVO", ...(brandId ? { brandId } : {}) },
      orderBy: { updatedAt: "desc" },
    });
    return rows.map((r) => this.present(r));
  }

  /** "Is Glovo working here?" — answered from what we can see without calling Glovo. */
  async health(tenantId: string, connectionId: string) {
    const conn = await this.prisma.brandPlatformConnection.findFirst({
      where: { id: connectionId, tenantId, platform: "GLOVO" },
    });
    if (!conn) throw new NotFoundException("Glovo connection not found");
    const lastOrder = await this.prisma.order.findFirst({
      where: {
        tenantId,
        locationId: conn.locationId,
        brandId: conn.brandId,
        platform: "GLOVO" as any,
      },
      orderBy: { createdAt: "desc" },
      select: { id: true, displayId: true, createdAt: true, status: true },
    });
    return {
      ...this.present(conn),
      tokenConfigured: this.client.configured,
      webhookAuthEnforced: this.client.inboundTokenConfigured,
      environment: this.client.env,
      lastOrder,
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

  /** Connection row → API shape. Never exposes the menu feed token. */
  present(conn: any) {
    const metadata = (conn.metadata ?? {}) as Record<string, any>;
    const pub = metadata.glovoMenuPublish ?? null;
    return {
      id: conn.id,
      brandId: conn.brandId,
      locationId: conn.locationId,
      status: conn.status,
      storeId: conn.externalStoreId,
      lastWebhookAt: conn.lastWebhookAt,
      lastError: conn.lastError,
      updatedAt: conn.updatedAt,
      menuPublish: pub
        ? {
            menuId: pub.menuId ?? null,
            status: pub.status ?? null,
            details: pub.details ?? [],
            sentAt: pub.sentAt ?? null,
            fetchedAt: pub.fetchedAt ?? null,
            transactionId: pub.transactionId ?? null,
            uploadsLast24h: Array.isArray(pub.uploads)
              ? pub.uploads.filter((t: string) => Date.now() - Date.parse(t) < 24 * 3600_000).length
              : 0,
          }
        : null,
    };
  }
}
