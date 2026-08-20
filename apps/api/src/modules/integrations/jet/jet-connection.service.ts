import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from "@nestjs/common";
import { PrismaService } from "../../../infrastructure/database/prisma.service";
import { ActivityLogService } from "../../logs/activity-log.service";
import { JetClientService } from "./jet-client.service";
import { JetCredentialResolver } from "./jet-credential.resolver";

// Phase JE-0 — per-brand Just Eat (JET Connect) connection.
//
// Connecting is a FORM, not an OAuth dance: JET has no merchant authorisation
// flow, so an operator supplies what their delivery manager sent them. The
// same three things HubRise's own Just Eat Flyt Bridge asks for:
//
//   restaurantReference — REQUIRED. JET's own id for the restaurant ("Restaurant
//                         ID" in their emails). Used on /menus,
//                         /item-availability and /restaurants/{ref}/*.
//   menuKey / orderKey  — OPTIONAL. Only brands JET issues their own keys to
//                         (over 6 locations) have these; everyone else falls
//                         through to the country/platform keys.
//
// Plus one JET's own bridge does not ask for, because there HubRise IS the POS
// and its location id fills the role:
//
//   posLocationId       — what JET stamps on every inbound order. It is the
//                         routing key that turns an order into a
//                         tenant/brand/location, so without it orders arrive
//                         and match nothing. It DEFAULTS to the restaurant
//                         reference, which is what JET configures when a
//                         partner does not specify one — override it only when
//                         JET tells you they are sending something else.
//
// Keeping this a two-minute form matters beyond convenience: the contract is
// 200 locations onboarded within 90 days of the pilot, which is roughly three
// restaurants every working day. Anything requiring a support ticket per store
// does not reach that number.

@Injectable()
export class JetConnectionService {
  private readonly logger = new Logger(JetConnectionService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly client: JetClientService,
    private readonly credentials: JetCredentialResolver,
    @Optional() private readonly activity?: ActivityLogService,
  ) {}

  async connect(
    tenantId: string,
    body: {
      brandId: string;
      locationId: string;
      /** JET's own restaurant id — what their onboarding email calls the Restaurant ID. */
      restaurantReference: string;
      /** What JET stamps on inbound orders. Defaults to the restaurant reference. */
      posLocationId?: string;
      brandSlug?: string;
      country?: string;
      /** Brand-issued keys, for brands JET gives their own (>6 locations). */
      menuKey?: string;
      orderKey?: string;
    },
  ) {
    const restaurantReference = (body.restaurantReference ?? "").trim();
    if (!restaurantReference) {
      throw new BadRequestException(
        "A Restaurant ID is required — Just Eat sends it once your integration is approved.",
      );
    }
    // The two ids are the same in the normal case, so asking twice would be
    // noise. Only a partner JET explicitly configures differently needs the
    // override.
    const posLocationId = (body.posLocationId ?? "").trim() || restaurantReference;

    // The POS location id is how an inbound order finds its restaurant, so a
    // duplicate would route orders to whichever row was found first. Rejecting
    // it here beats debugging misrouted live orders later.
    const clash = await this.prisma.brandPlatformConnection.findFirst({
      where: {
        platform: "JUST_EAT",
        externalStoreId: posLocationId,
        NOT: { AND: [{ brandId: body.brandId }, { locationId: body.locationId }] },
      },
      select: { id: true, brandId: true, locationId: true },
    });
    if (clash) {
      throw new BadRequestException(
        `POS location ID "${posLocationId}" is already used by another Just Eat connection. ` +
          `Each restaurant needs its own — orders are routed by this value.`,
      );
    }

    await this.assertOwned(tenantId, body.brandId, body.locationId);

    const metadata: Record<string, unknown> = {
      posLocationId,
      restaurantReference,
      country: (body.country ?? "").trim().toUpperCase() || null,
    };
    // Only store a credentials envelope when the brand actually has its own
    // keys; otherwise the resolver's country/platform tiers answer.
    //
    // A re-save with the key fields left blank KEEPS whatever is already
    // stored. The manage panel never renders a saved key back (it is a
    // secret), so treating blank as "clear it" would wipe a brand's keys every
    // time someone corrected a typo in the Restaurant ID.
    if (body.menuKey?.trim() || body.orderKey?.trim()) {
      metadata.credentials = this.credentials.encryptForStorage({
        menuKey: body.menuKey,
        orderKey: body.orderKey,
      });
    } else {
      const existing = await this.prisma.brandPlatformConnection.findFirst({
        where: {
          brandId: body.brandId,
          locationId: body.locationId,
          platform: "JUST_EAT",
        },
        select: { metadata: true },
      });
      const kept = ((existing?.metadata as any) ?? {}).credentials;
      if (kept) metadata.credentials = kept;
    }

    const connection = await this.prisma.brandPlatformConnection.upsert({
      where: {
        brandId_locationId_platform: {
          brandId: body.brandId,
          locationId: body.locationId,
          platform: "JUST_EAT",
        },
      },
      create: {
        tenantId,
        brandId: body.brandId,
        locationId: body.locationId,
        platform: "JUST_EAT",
        status: "connected",
        externalStoreId: posLocationId,
        externalBrandId: (body.brandSlug ?? "").trim() || null,
        metadata: metadata as any,
      },
      update: {
        status: "connected",
        externalStoreId: posLocationId,
        externalBrandId: (body.brandSlug ?? "").trim() || null,
        lastError: null,
        metadata: metadata as any,
      },
    });

    this.activity?.record({
      tenantId,
      locationId: body.locationId,
      brandId: body.brandId,
      category: "CONNECTION",
      channel: "JUST_EAT",
      action: "connection.connect",
      status: "SUCCESS",
      message: `Just Eat connected (POS location ${posLocationId})`,
      details: {
        restaurantReference: metadata.restaurantReference,
        brandKeys: !!metadata.credentials,
      },
    });

    this.logger.log(
      `JET connected brand ${body.brandId} @ ${body.locationId} → ` +
        `restaurant ${restaurantReference}, posLocationId ${posLocationId}` +
        (metadata.credentials ? " (brand keys stored)" : " (shared keys)"),
    );
    return this.present(connection);
  }

  async disconnect(tenantId: string, connectionId: string) {
    const conn = await this.prisma.brandPlatformConnection.findFirst({
      where: { id: connectionId, tenantId, platform: "JUST_EAT" },
    });
    if (!conn) throw new NotFoundException("Just Eat connection not found");

    // Clear the credentials rather than leaving an orphaned envelope behind,
    // and drop the store id so the value can be reused by another connection.
    const metadata = { ...((conn.metadata as any) ?? {}) };
    delete metadata.credentials;

    const updated = await this.prisma.brandPlatformConnection.update({
      where: { id: connectionId },
      data: {
        status: "not_connected",
        externalStoreId: null,
        metadata: metadata as any,
      },
    });

    this.activity?.record({
      tenantId,
      locationId: conn.locationId,
      brandId: conn.brandId,
      category: "CONNECTION",
      channel: "JUST_EAT",
      action: "connection.disconnect",
      status: "INFO",
      message: "Just Eat disconnected",
    });
    return this.present(updated);
  }

  /** Connections in scope, for the brand channels grid. */
  async list(tenantId: string, brandId?: string) {
    const rows = await this.prisma.brandPlatformConnection.findMany({
      where: { tenantId, platform: "JUST_EAT", ...(brandId ? { brandId } : {}) },
      orderBy: { updatedAt: "desc" },
    });
    return rows.map((r) => this.present(r));
  }

  /**
   * Operational readiness for one connection.
   *
   * Answers the question an operator actually asks — "is Just Eat working
   * here?" — from what we can check without calling JET: are the keys
   * resolvable, is the inbound webhook authenticated, and when did an order
   * last arrive. A restaurant that has been connected for a week with no
   * webhook is the failure mode worth surfacing.
   */
  async health(tenantId: string, connectionId: string) {
    const conn = await this.prisma.brandPlatformConnection.findFirst({
      where: { id: connectionId, tenantId, platform: "JUST_EAT" },
    });
    if (!conn) throw new NotFoundException("Just Eat connection not found");

    const [menu, order] = await Promise.all([
      this.credentials.resolve({
        type: "menu",
        brandId: conn.brandId,
        locationId: conn.locationId,
        country: ((conn.metadata as any) ?? {}).country,
      }),
      this.credentials.resolve({
        type: "order",
        brandId: conn.brandId,
        locationId: conn.locationId,
        country: ((conn.metadata as any) ?? {}).country,
      }),
    ]);

    const lastOrder = await this.prisma.order.findFirst({
      where: { tenantId, locationId: conn.locationId, platform: "JUST_EAT" },
      orderBy: { createdAt: "desc" },
      select: { id: true, displayId: true, createdAt: true, status: true },
    });

    return {
      ...this.present(conn),
      // Sources only — never the key values.
      menuKey: { configured: !!menu.key, source: menu.source },
      orderKey: { configured: !!order.key, source: order.source },
      webhookSignatureEnforced: this.client.webhookSecretConfigured,
      inboundApiKeyEnforced: this.client.inboundApiKeyConfigured,
      lastOrder,
    };
  }

  private async assertOwned(
    tenantId: string,
    brandId: string,
    locationId: string,
  ): Promise<void> {
    const [brand, location] = await Promise.all([
      this.prisma.brand.findFirst({
        where: { id: brandId, tenantId, deletedAt: null },
        select: { id: true },
      }),
      // Location has no tenantId column — it is tenant-scoped through its
      // brand, the same guard MenuAvailabilityService uses.
      this.prisma.location.findFirst({
        where: { id: locationId, deletedAt: null, brand: { tenantId } },
        select: { id: true },
      }),
    ]);
    if (!brand) throw new NotFoundException("Brand not found");
    if (!location) throw new NotFoundException("Location not found");
  }

  /** Connection row → API shape. Never exposes the credentials envelope. */
  private present(conn: any) {
    const metadata = (conn.metadata ?? {}) as Record<string, any>;
    return {
      id: conn.id,
      brandId: conn.brandId,
      locationId: conn.locationId,
      status: conn.status,
      posLocationId: conn.externalStoreId,
      restaurantReference: metadata.restaurantReference ?? null,
      brandSlug: conn.externalBrandId,
      country: metadata.country ?? null,
      hasBrandKeys: !!metadata.credentials,
      lastWebhookAt: conn.lastWebhookAt,
      lastError: conn.lastError,
      updatedAt: conn.updatedAt,
    };
  }
}
