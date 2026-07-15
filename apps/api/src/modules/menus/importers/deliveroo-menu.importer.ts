import { BadRequestException, Injectable, Logger, Optional } from "@nestjs/common";
import { PrismaService } from "../../../infrastructure/database/prisma.service";
import { MenuWriterService } from "./menu-writer.service";
import { DeliverooClientService } from "../../integrations/deliveroo/deliveroo-client.service";
import { SupabaseStorageService } from "../../uploads/supabase-storage.service";
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

// Our public API origin. Menus we published to Deliveroo carry ABSOLUTE
// image URLs pointing back at this origin (Deliveroo's servers must be able
// to fetch them). But the DASHBOARD must NOT use that absolute form: the web
// app deliberately proxies /api/* through Next (Render strips CORS headers,
// and helmet's default Cross-Origin-Resource-Policy: same-origin makes
// browsers discard cross-origin <img> loads — the API logs 200, the image
// shows broken). So on import we RELATIVISE our own URLs back to /api/...,
// matching how HubRise imports store them. Truly external URLs (Deliveroo
// CDN etc.) pass through untouched.
const PROD_API_ORIGIN = "https://orderhub-api-0re6.onrender.com";
export const relativiseImage = (url: string | null | undefined): string | null => {
  const u = (url ?? "").trim();
  if (!u) return null;
  if (u.startsWith(`${PROD_API_ORIGIN}/`)) {
    return u.slice(PROD_API_ORIGIN.length);
  }
  return u; // relative already, or a genuinely external host
};

// Marketplace CDN hosts whose images the browser can't load directly
// (cross-origin + hotlink/short-lived tokens). When we couldn't rehost an
// imported image to our own storage, we serve it through the same-origin
// proxy endpoint (GET /api/v1/menus/import-image) instead. Only these hosts
// are proxied — storage URLs and our own relative paths are left untouched.
const PROXY_IMAGE_HOSTS =
  /(?:^|\.)(hubrise-apps\.com|deliveroo\.co\.uk|deliveroo\.com)$/i;
export const proxyMarketplaceImage = (
  url: string | null | undefined,
): string | null => {
  const u = (url ?? "").trim();
  if (!u || !/^https?:\/\//i.test(u)) return u || null; // relative/our-origin
  try {
    if (!PROXY_IMAGE_HOSTS.test(new URL(u).hostname)) return u; // storage etc.
  } catch {
    return u;
  }
  return `/api/v1/menus/import-image?u=${encodeURIComponent(u)}`;
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
    // Phase — rehost imported images to our own storage at import time,
    // exactly like the Uber importer. Deliveroo hands back image URLs on
    // HubRise's app CDN (deliveroo.hubrise-apps.com) that are short-lived /
    // context-scoped: fetchable at import, but 400 by the time the browser
    // renders them — which is why Uber imports showed images and Deliveroo
    // ones didn't. Optional so the module still boots without storage.
    @Optional() private readonly storage?: SupabaseStorageService,
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

    // Rehost external images to our own storage NOW, while the Deliveroo/
    // HubRise-CDN URLs are still valid (they expire → 400 by render time).
    // Runs before relativise so our-own-origin URLs are left for it below.
    await this.rehostImages(normalized);

    // Relativise our own API-origin image URLs back to /api/... so the
    // dashboard/storefront load them same-origin via the Next rewrite (see
    // relativiseImage above for why absolute breaks in the browser).
    for (const p of normalized.products) {
      p.imageUrl = relativiseImage(p.imageUrl);
      // Fallback when storage isn't configured (rehostImages was skipped) or a
      // single image failed to rehost: the URL is still an external Deliveroo/
      // HubRise CDN URL the browser can't render (cross-origin + hotlink
      // protection). Route it through our same-origin proxy so it loads.
      p.imageUrl = proxyMarketplaceImage(p.imageUrl);
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

  /**
   * Fetch each EXTERNAL product image and re-host it on our own storage so
   * the dashboard/storefront render a permanent, loadable URL. Mirrors the
   * Uber importer (which is why Uber images work and Deliveroo's didn't).
   *
   * Only external absolute URLs are rehosted; our-own-origin URLs are left
   * for relativiseImage(). Best-effort per image — a fetch that fails (e.g.
   * an already-expired HubRise-CDN URL) leaves that product's URL untouched.
   */
  private async rehostImages(normalized: {
    products: Array<{ imageUrl?: string | null }>;
  }): Promise<void> {
    if (!this.storage?.isConfigured()) return;
    const targets = normalized.products.filter(
      (p) =>
        p.imageUrl &&
        /^https?:\/\//i.test(p.imageUrl) &&
        !p.imageUrl.startsWith(`${PROD_API_ORIGIN}/`),
    );
    if (targets.length === 0) return;
    this.logger.log(
      `Deliveroo menu import: rehosting ${targets.length} images (sample: ${targets[0]!.imageUrl!.slice(0, 160)})`,
    );
    const cache = new Map<string, string | null>();
    const rehostOne = async (url: string): Promise<string | null> => {
      try {
        const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
        if (!res.ok) {
          this.logger.warn(
            `Deliveroo image fetch ${res.status} for ${url.slice(0, 120)}`,
          );
          return null;
        }
        const ct = res.headers.get("content-type") ?? "image/jpeg";
        if (!ct.startsWith("image/")) return null;
        const buf = Buffer.from(await res.arrayBuffer());
        if (buf.length === 0 || buf.length > 8 * 1024 * 1024) return null;
        return await this.storage!.uploadDataUrl(
          `data:${ct};base64,${buf.toString("base64")}`,
          "deliveroo-import",
        );
      } catch (err: any) {
        this.logger.warn(
          `Deliveroo image rehost failed for ${url.slice(0, 120)}: ${err?.message ?? err}`,
        );
        return null;
      }
    };
    // Small concurrency batches — imports are one-off, don't hammer the CDN.
    const CHUNK = 5;
    for (let i = 0; i < targets.length; i += CHUNK) {
      await Promise.all(
        targets.slice(i, i + CHUNK).map(async (p) => {
          const url = p.imageUrl!;
          if (!cache.has(url)) cache.set(url, await rehostOne(url));
          const hosted = cache.get(url);
          if (hosted) p.imageUrl = hosted;
        }),
      );
    }
    const ok = [...cache.values()].filter(Boolean).length;
    this.logger.log(
      `Deliveroo menu import: rehosted ${ok}/${cache.size} unique images`,
    );
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
