import { BadRequestException, Injectable, Logger, NotFoundException, Optional } from "@nestjs/common";
import { PrismaService } from "../../../infrastructure/database/prisma.service";
import { ActivityLogService } from "../../logs/activity-log.service";
import { KeetaAuthService } from "./keeta-auth.service";
import { KeetaClientService } from "./keeta-client.service";

// Phase KT-1 — which Keeta store is which of our brand × location pairs.
//
// After a merchant authorizes, Keeta tell us the stores the token covers.
// The operator maps each to one of their brands at one location. A Keeta
// store can be mapped to exactly ONE pair — it is the only thing that routes
// an order to a kitchen, so a second claim on it is refused here rather than
// discovered as a misrouted order.

@Injectable()
export class KeetaConnectionService {
  private readonly logger = new Logger(KeetaConnectionService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly client: KeetaClientService,
    private readonly auth: KeetaAuthService,
    @Optional() private readonly activity?: ActivityLogService,
  ) {}

  async connect(
    tenantId: string,
    body: { brandId: string; locationId: string; authorizationId: string; shopId: string },
  ) {
    const [brand, location, authz] = await Promise.all([
      this.prisma.brand.findFirst({ where: { id: body.brandId, tenantId, deletedAt: null }, select: { id: true } }),
      this.prisma.location.findFirst({
        where: { id: body.locationId, deletedAt: null, brand: { tenantId } },
        select: { id: true },
      }),
      this.prisma.keetaAuthorization.findFirst({
        where: { id: body.authorizationId, tenantId },
        select: { id: true, keetaBrandId: true, shops: true, status: true },
      }),
    ]);
    if (!brand) throw new NotFoundException("Brand not found");
    if (!location) throw new NotFoundException("Location not found");
    if (!authz) throw new NotFoundException("Keeta authorization not found");
    if (authz.status === "revoked") {
      throw new BadRequestException("That Keeta authorization was revoked by the merchant — authorize again.");
    }

    const shopId = String(body.shopId ?? "").trim();
    const shop = ((authz.shops as any[]) ?? []).find((s) => String(s?.id) === shopId);
    if (!shop) {
      throw new BadRequestException(
        `Keeta store ${shopId} isn't in this authorization. Ask the merchant to add it in Keeta, or refresh the store list.`,
      );
    }

    const clash = await this.prisma.brandPlatformConnection.findFirst({
      where: {
        platform: "KEETA",
        externalStoreId: shopId,
        status: { not: "not_connected" },
        NOT: { AND: [{ brandId: body.brandId }, { locationId: body.locationId }] },
      },
      select: { id: true },
    });
    if (clash) {
      throw new BadRequestException(
        `Keeta store ${shopId} is already connected to another brand or location. Disconnect it there first.`,
      );
    }

    const conn = await this.auth.upsertConnection({
      tenantId,
      brandId: body.brandId,
      locationId: body.locationId,
      shopId,
      shopName: shop?.name ?? null,
      authorizationId: authz.id,
      keetaBrandId: authz.keetaBrandId,
    });
    this.activity?.record({
      tenantId,
      brandId: body.brandId,
      locationId: body.locationId,
      category: "CONNECTION",
      channel: "KEETA",
      action: "connection.connect",
      status: "SUCCESS",
      message: `Keeta connected — store "${shop?.name ?? shopId}" (${shopId}). Publish the menu next.`,
    });
    return this.present(conn);
  }

  async disconnect(tenantId: string, connectionId: string) {
    const conn = await this.prisma.brandPlatformConnection.findFirst({
      where: { id: connectionId, tenantId, platform: "KEETA" },
    });
    if (!conn) throw new NotFoundException("Keeta connection not found");
    const updated = await this.prisma.brandPlatformConnection.update({
      where: { id: connectionId },
      data: { status: "not_connected", externalStoreId: null },
    });
    this.activity?.record({
      tenantId,
      brandId: conn.brandId,
      locationId: conn.locationId,
      category: "CONNECTION",
      channel: "KEETA",
      action: "connection.disconnect",
      status: "INFO",
      message:
        "Keeta disconnected here. Orders for that store will no longer reach this board — they stay in the " +
        "Keeta merchant app. To stop OrderHub's access entirely, the merchant revokes it in Keeta.",
    });
    return this.present(updated);
  }

  async list(tenantId: string, brandId?: string) {
    const rows = await this.prisma.brandPlatformConnection.findMany({
      where: { tenantId, platform: "KEETA", ...(brandId ? { brandId } : {}) },
      orderBy: { updatedAt: "desc" },
    });
    return rows.map((r) => this.present(r));
  }

  async health(tenantId: string, connectionId: string) {
    const conn = await this.prisma.brandPlatformConnection.findFirst({
      where: { id: connectionId, tenantId, platform: "KEETA" },
    });
    if (!conn) throw new NotFoundException("Keeta connection not found");
    const authId = ((conn.metadata as any) ?? {}).keetaAuthorizationId;
    const [authz, lastOrder] = await Promise.all([
      authId
        ? this.prisma.keetaAuthorization.findUnique({
            where: { id: authId },
            select: { status: true, expiresAt: true, brandName: true, lastError: true },
          })
        : Promise.resolve(null),
      this.prisma.order.findFirst({
        where: { tenantId, locationId: conn.locationId, brandId: conn.brandId, platform: "KEETA" as any },
        orderBy: { createdAt: "desc" },
        select: { id: true, displayId: true, createdAt: true, status: true },
      }),
    ]);
    return {
      ...this.present(conn),
      configured: this.client.configured,
      environment: this.client.env,
      authorization: authz,
      lastOrder,
    };
  }

  present(conn: any) {
    const m = (conn.metadata ?? {}) as Record<string, any>;
    const pub = m.keetaMenuPublish ?? null;
    return {
      id: conn.id,
      brandId: conn.brandId,
      locationId: conn.locationId,
      status: conn.status,
      shopId: conn.externalStoreId,
      shopName: m.keetaShopName ?? null,
      keetaBrandId: conn.externalBrandId,
      authorizationId: m.keetaAuthorizationId ?? null,
      lastWebhookAt: conn.lastWebhookAt,
      lastError: conn.lastError,
      updatedAt: conn.updatedAt,
      storeStatus: m.keetaStoreStatus ?? null,
      menuPublish: pub
        ? {
            menuId: pub.menuId ?? null,
            status: pub.status ?? null,
            taskId: pub.taskId ?? null,
            sentAt: pub.sentAt ?? null,
            finishedAt: pub.finishedAt ?? null,
            errors: pub.errors ?? [],
            pictureErrors: pub.pictureErrors ?? [],
            warnings: pub.warnings ?? [],
            stats: pub.stats ?? null,
          }
        : null,
    };
  }
}
