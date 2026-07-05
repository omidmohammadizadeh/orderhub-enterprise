import { BadRequestException, Injectable, Logger, Optional } from "@nestjs/common";
import { PrismaService } from "../../../infrastructure/database/prisma.service";
import { UberEatsClientService } from "../../integrations/ubereats/ubereats-client.service";
import { SupabaseStorageService } from "../../uploads/supabase-storage.service";
import { MenuWriterService } from "./menu-writer.service";
import {
  classifyUberMenu,
  type UberMenuPayload,
} from "./uber-menu.classifier";

// ── Uber Eats menu importer ─────────────────────────────────────────────────
//
// The HTTP fetch is intentionally thin — operators don't have real Uber
// credentials wired up at this stage of Phase AK. The importer accepts
// either:
//   - a `payload` object (the raw JSON, e.g. from a saved test fixture
//     or pasted from the Uber dashboard's "View raw menu" panel), or
//   - a `storeId` + an access token from the active Integration row,
//     in which case it calls Uber's stores/menus endpoint directly.
//
// Both paths converge on `MenuWriterService.apply()`.
//
// Reasons to support the payload path now (not just later):
//   1. The classifier is unit-testable with fixture JSON.
//   2. Operators piloting on Uber sandbox can paste a payload and verify
//      the rendered menu before any real OAuth is wired.
//   3. Recovery: a failed import can be replayed against
//      `menu.rawImportPayload` without re-fetching from Uber.

const UBER_MENU_URL = (storeId: string) =>
  `https://api.uber.com/v2/eats/stores/${storeId}/menus?menu_type=MENU_TYPE_FULFILLMENT_DELIVERY`;

interface ImportArgs {
  menuId: string;
  tenantId: string;
  /** Pasted JSON or fixture — bypasses the HTTP fetch when present. */
  payload?: UberMenuPayload;
  /** Uber store id (used when payload is not supplied). */
  storeId?: string;
  /** Optional access token override (otherwise resolved from Integration). */
  accessToken?: string;
}

@Injectable()
export class UberMenuImporter {
  private readonly logger = new Logger(UberMenuImporter.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly writer: MenuWriterService,
    // Live fetch through the connected app credentials (Phase UE) — the
    // legacy accessToken/payload paths stay for fixtures + recovery.
    @Optional() private readonly uberClient?: UberEatsClientService,
    // Rehost item images at import time — Uber's Get Menu can return signed,
    // short-lived CDN URLs that expire (broken thumbnails later). We download
    // the bytes once and store a permanent copy in our own bucket.
    @Optional() private readonly storage?: SupabaseStorageService,
  ) {}

  /**
   * "Import from channel → Uber Eats": resolve the brand's connected store,
   * create a fresh menu for the brand+location, pull the LIVE menu via the
   * Menu API (GET /v2/eats/stores/{id}/menus) and write it in. Mirrors
   * DeliverooMenuImporter.importFromConnection.
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
        platform: "UBER_EATS",
        externalStoreId: { not: null },
        status: { in: ["connected", "suspended"] },
        ...(args.locationId ? { locationId: args.locationId } : {}),
      },
      select: { externalStoreId: true },
    });
    if (!conn) {
      throw new BadRequestException(
        "Uber Eats isn't connected for this brand at that location yet. Connect it under Locations → Brands → Uber Eats first.",
      );
    }

    const menu = await this.prisma.menu.create({
      data: {
        brandId: args.brandId,
        locationId: args.locationId,
        name: `${brand.name} — Uber Eats`,
        platformSource: "ubereats",
        externalParentId: conn.externalStoreId,
      },
      select: { id: true },
    });

    await this.import({
      menuId: menu.id,
      tenantId: args.tenantId,
      storeId: conn.externalStoreId!,
    });

    return this.prisma.menu.findUnique({ where: { id: menu.id } });
  }

  async import(args: ImportArgs) {
    const menu = await this.prisma.menu.findFirst({
      where: { id: args.menuId, brand: { tenantId: args.tenantId } },
      select: { id: true, brandId: true, locationId: true },
    });
    if (!menu) throw new BadRequestException("Menu not found or not accessible");

    let payload: UberMenuPayload;
    if (args.payload) {
      payload = args.payload;
    } else {
      if (!args.storeId) {
        throw new BadRequestException(
          "Provide either payload or storeId for Uber import",
        );
      }
      payload = await this.fetchFromUber(args.storeId, args.accessToken);
    }

    // Shape probe: first item's keys + image-ish fields, so a missing-image
    // import is diagnosable from Render without the raw payload.
    try {
      const first: any = (payload as any)?.items?.[0];
      if (first) {
        this.logger.log(
          `Uber menu import shape: itemKeys=[${Object.keys(first).join(",")}] image_url=${JSON.stringify(first.image_url ?? null)} image=${JSON.stringify(first.image ?? null)?.slice(0, 120)}`,
        );
      }
    } catch {
      /* diagnostics only */
    }

    const normalized = classifyUberMenu(payload);
    await this.rehostImages(normalized);
    const result = await this.writer.apply({
      menuId: menu.id,
      tenantId: args.tenantId,
      brandId: menu.brandId,
      locationId: menu.locationId,
      normalized,
    });
    // Uber's Get Menu NEVER returns images (live-verified: item keys are
    // id/title/price_info/tax_info/dish_info/product_info/bundled_items —
    // image_url is write-only on their API). Heal by borrowing images from
    // same-named items already in the brand (e.g. the HubRise-imported twin
    // of the same catalog).
    await this.backfillImagesFromBrandTwins(menu.brandId, args.tenantId);
    return result;
  }

  /**
   * For every imageless Uber-imported item in the brand, copy the image of
   * a same-named brand item that has one. Names are compared trimmed +
   * case-insensitive. Best-effort — never throws.
   */
  private async backfillImagesFromBrandTwins(
    brandId: string | null,
    tenantId: string,
  ): Promise<void> {
    if (!brandId) return;
    try {
      const items = await this.prisma.menuItem.findMany({
        where: { brandId },
        select: {
          id: true,
          name: true,
          imageUrl: true,
          platformSource: true,
        },
      });
      const donorByName = new Map<string, string>();
      for (const it of items) {
        const key = it.name?.trim().toLowerCase();
        if (!key) continue;
        const url = it.imageUrl ?? "";
        if (url && !url.startsWith("data:") && !donorByName.has(key)) {
          donorByName.set(key, url);
        }
      }
      let healed = 0;
      for (const it of items) {
        if (it.imageUrl) continue;
        const donor = donorByName.get(it.name?.trim().toLowerCase() ?? "");
        if (!donor) continue;
        await this.prisma.menuItem.update({
          where: { id: it.id },
          data: { imageUrl: donor },
        });
        healed++;
      }
      if (healed > 0) {
        this.logger.log(
          `Uber menu import: backfilled ${healed} item images from same-named brand items`,
        );
      }
    } catch (err: any) {
      this.logger.warn(
        `Uber menu import image backfill failed: ${err?.message ?? err}`,
      );
    }
  }

  private async fetchFromUber(
    storeId: string,
    accessToken: string | undefined,
  ): Promise<UberMenuPayload> {
    if (!accessToken) {
      // Phase UE — no operator-supplied token needed: mint a client-
      // credentials token (eats.store) through the connected app.
      if (this.uberClient?.configured) {
        return await this.uberClient.request<UberMenuPayload>(
          "GET",
          `/v2/eats/stores/${encodeURIComponent(storeId)}/menus`,
          { scopes: ["eats.store"] },
        );
      }
      throw new BadRequestException(
        "Uber access token required (configure the Integration first)",
      );
    }
    const res = await fetch(UBER_MENU_URL(storeId), {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new BadRequestException(
        `Uber Eats returned ${res.status}: ${body.slice(0, 200)}`,
      );
    }
    return (await res.json()) as UberMenuPayload;
  }

  /**
   * Download every external product image and re-upload to our storage so
   * the stored URL is permanent. Best-effort per image: failures keep the
   * original URL. Identical source URLs are fetched once.
   */
  private async rehostImages(normalized: {
    products: Array<{ imageUrl?: string | null }>;
  }): Promise<void> {
    if (!this.storage?.isConfigured()) return;
    const targets = normalized.products.filter(
      (p) => p.imageUrl && /^https?:\/\//i.test(p.imageUrl),
    );
    if (targets.length === 0) return;
    this.logger.log(
      `Uber menu import: rehosting ${targets.length} images (sample: ${targets[0]!.imageUrl!.slice(0, 160)})`,
    );
    const cache = new Map<string, string | null>();
    const rehostOne = async (url: string): Promise<string | null> => {
      try {
        const res = await fetch(url, {
          signal: AbortSignal.timeout(10_000),
        });
        if (!res.ok) {
          this.logger.warn(
            `Uber image fetch ${res.status} for ${url.slice(0, 120)}`,
          );
          return null;
        }
        const ct = res.headers.get("content-type") ?? "image/jpeg";
        if (!ct.startsWith("image/")) return null;
        const buf = Buffer.from(await res.arrayBuffer());
        if (buf.length === 0 || buf.length > 8 * 1024 * 1024) return null;
        return await this.storage!.uploadDataUrl(
          `data:${ct};base64,${buf.toString("base64")}`,
          "uber-import",
        );
      } catch (err: any) {
        this.logger.warn(
          `Uber image rehost failed for ${url.slice(0, 120)}: ${err?.message ?? err}`,
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
      `Uber menu import: rehosted ${ok}/${cache.size} unique images`,
    );
  }
}
