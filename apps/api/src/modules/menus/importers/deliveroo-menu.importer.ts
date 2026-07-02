import { BadRequestException, Injectable, Logger } from "@nestjs/common";
import { PrismaService } from "../../../infrastructure/database/prisma.service";
import { MenuWriterService } from "./menu-writer.service";
import { DeliverooClientService } from "../../integrations/deliveroo/deliveroo-client.service";
import {
  classifyDeliverooMenu,
  type DeliverooMenuPayload,
} from "./deliveroo-menu.classifier";

// ── Deliveroo menu importer ────────────────────────────────────────────────
//
// Same shape as the Uber importer (see its header comment). Two HTTP hops
// when fetching live:
//   1. GET /site/v1/restaurant_locations/{storeId} → resolves the
//      Deliveroo brand id, which we cache on the Integration row for
//      next time.
//   2. GET /menu/v2/brands/{brandId}/sites/{storeId}/menu → the menu
//      itself.
//
// We expose the same payload-bypass affordance: operators can paste a
// raw export from the Deliveroo dashboard.

const DELIVEROO_RESTAURANT_URL = (storeId: string) =>
  `https://api.developers.deliveroo.com/site/v1/restaurant_locations/${storeId}`;
const DELIVEROO_MENU_URL = (brandId: string, storeId: string) =>
  `https://api.developers.deliveroo.com/menu/v2/brands/${brandId}/sites/${storeId}/menu`;

// Our public API origin — used to absolutise any relative /api image path a
// Deliveroo menu might still carry (e.g. images published before we started
// absolutising). Matches the origin the HubRise callback hard-codes.
const PROD_API_ORIGIN = "https://orderhub-api-0re6.onrender.com";
const absolutiseImage = (url: string | null | undefined): string | null => {
  const u = (url ?? "").trim();
  if (!u) return null;
  if (u.startsWith("/")) return `${PROD_API_ORIGIN}${u}`;
  return u; // already absolute (http/https) or a data URL — leave as-is
};

interface ImportArgs {
  menuId: string;
  tenantId: string;
  payload?: DeliverooMenuPayload;
  storeId?: string;
  /** Pre-resolved Deliveroo brand id (skips the resolve hop when present). */
  deliverooBrandId?: string;
  accessToken?: string;
}

@Injectable()
export class DeliverooMenuImporter {
  private readonly logger = new Logger(DeliverooMenuImporter.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly writer: MenuWriterService,
    private readonly client: DeliverooClientService,
  ) {}

  /**
   * Create a fresh menu for the brand/location and import the brand's
   * connected Deliveroo store into it — the "Create menu → Import from
   * channel → Deliveroo" flow. Uses the platform OAuth client (no per-user
   * access token needed); the Site ID + Deliveroo Brand ID come from the
   * BrandPlatformConnection saved when the operator connected Deliveroo.
   */
  async importFromConnection(args: {
    tenantId: string;
    brandId: string;
    locationId: string;
  }) {
    const brand = await this.prisma.brand.findFirst({
      where: { id: args.brandId, tenantId: args.tenantId, deletedAt: null },
      select: { id: true, name: true },
    });
    if (!brand) throw new BadRequestException("Brand not found");

    const conn = await this.prisma.brandPlatformConnection.findFirst({
      where: {
        brandId: args.brandId,
        tenantId: args.tenantId,
        platform: "DELIVEROO",
        externalStoreId: { not: null },
        externalBrandId: { not: null },
      },
      select: { externalStoreId: true, externalBrandId: true },
    });
    if (!conn) {
      throw new BadRequestException(
        "Deliveroo isn't connected for this brand yet. Connect it under Locations → Brands → Deliveroo first.",
      );
    }

    const menu = await this.prisma.menu.create({
      data: {
        brandId: args.brandId,
        locationId: args.locationId,
        name: `${brand.name} — Deliveroo`,
        platformSource: "deliveroo",
        externalParentId: conn.externalBrandId,
      },
      select: { id: true },
    });

    await this.import({
      menuId: menu.id,
      tenantId: args.tenantId,
      storeId: conn.externalStoreId!,
      deliverooBrandId: conn.externalBrandId!,
    });

    return this.prisma.menu.findUnique({ where: { id: menu.id } });
  }

  async import(args: ImportArgs) {
    const menu = await this.prisma.menu.findFirst({
      where: { id: args.menuId, brand: { tenantId: args.tenantId } },
      select: { id: true, brandId: true, locationId: true },
    });
    if (!menu) throw new BadRequestException("Menu not found or not accessible");

    let payload: DeliverooMenuPayload;
    if (args.payload) {
      payload = args.payload;
    } else {
      if (!args.storeId) {
        throw new BadRequestException(
          "Provide either payload or storeId for Deliveroo import",
        );
      }
      payload = await this.fetchFromDeliveroo(
        args.storeId,
        args.deliverooBrandId,
        args.accessToken,
      );
    }

    const normalized = classifyDeliverooMenu(payload);

    // Belt-and-suspenders: absolutise any relative image path so the dashboard
    // + storefront render it against the API origin, not the web origin.
    for (const p of normalized.products) {
      p.imageUrl = absolutiseImage(p.imageUrl);
    }

    // Diagnostic: how many products carried an image, plus a sample of what we
    // extracted AND the raw Deliveroo image field on the first item — so we
    // can see the exact URL shape (and whether it's publicly loadable) without
    // guessing.
    const withImg = normalized.products.filter((p) => p.imageUrl).length;
    const sample = normalized.products.find((p) => p.imageUrl)?.imageUrl;
    const firstItem: any = (payload?.menu?.items ?? [])[0];
    this.logger.log(
      `Deliveroo import menu=${menu.id}: ${normalized.products.length} products, ${withImg} with images; ` +
        `sample=${sample ?? "none"}; rawImage=${JSON.stringify(
          firstItem?.image ?? firstItem?.images ?? firstItem?.image_url ?? null,
        )?.slice(0, 300)}`,
    );

    return this.writer.apply({
      menuId: menu.id,
      tenantId: args.tenantId,
      brandId: menu.brandId,
      locationId: menu.locationId,
      normalized,
    });
  }

  private async fetchFromDeliveroo(
    storeId: string,
    deliverooBrandId: string | undefined,
    accessToken: string | undefined,
  ): Promise<DeliverooMenuPayload> {
    // Preferred path: the platform OAuth client (client-credentials) — used by
    // the connection-based import. `accessToken` is the legacy per-call path
    // kept for the raw-token importer.
    if (!accessToken) {
      let brandId = deliverooBrandId;
      if (!brandId) {
        const json = await this.client.request<{ brand_id?: string | string[] }>(
          "GET",
          `/site/v1/restaurant_locations/${encodeURIComponent(storeId)}`,
        );
        const b = Array.isArray(json?.brand_id) ? json.brand_id[0] : json?.brand_id;
        if (!b) {
          throw new BadRequestException(
            "Deliveroo didn't return a Brand ID for that Site ID.",
          );
        }
        brandId = b;
      }
      return this.client.request<DeliverooMenuPayload>(
        "GET",
        `/menu/v2/brands/${brandId}/sites/${encodeURIComponent(storeId)}/menu`,
      );
    }

    let brandId = deliverooBrandId;
    if (!brandId) {
      const r = await fetch(DELIVEROO_RESTAURANT_URL(storeId), {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      if (!r.ok) {
        const body = await r.text().catch(() => "");
        throw new BadRequestException(
          `Deliveroo restaurant_locations returned ${r.status}: ${body.slice(0, 200)}`,
        );
      }
      const json = (await r.json()) as { brand_id?: string };
      if (!json.brand_id) {
        throw new BadRequestException(
          "Deliveroo restaurant_locations response did not include brand_id",
        );
      }
      brandId = json.brand_id;
    }

    const r2 = await fetch(DELIVEROO_MENU_URL(brandId, storeId), {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!r2.ok) {
      const body = await r2.text().catch(() => "");
      throw new BadRequestException(
        `Deliveroo menu returned ${r2.status}: ${body.slice(0, 200)}`,
      );
    }
    return (await r2.json()) as DeliverooMenuPayload;
  }
}
