import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Cron } from "@nestjs/schedule";
import * as crypto from "crypto";
import { PrismaService } from "../../../infrastructure/database/prisma.service";
import { ActivityLogService } from "../../logs/activity-log.service";
import {
  VariantPriceResolverService,
  type VariantPriceMap,
} from "../../menus/variant-price-resolver.service";
import {
  extractSizeKey,
  getModifierPrice,
  isModifierAvailable,
  type ProductSku,
} from "@orderhub/shared";
import {
  buildSizeGroup,
  needsPerSizeExpansion,
  sizeBasePrice,
} from "../shared/publish-sizes";
import { GlovoApiError, GlovoClientService } from "./glovo-client.service";
import {
  buildGlovoMenu,
  type GlovoMenu,
  type GlovoSrcCategory,
  type GlovoSrcGroup,
  type GlovoSrcProduct,
} from "./glovo-menu.transformer";

// Phase GL-4 — publish an OrderHub menu to a Glovo store.
//
// Glovo does not take the menu in the request. The upload is:
//
//   POST /webhook/stores/{storeId}/menu  { menuUrl }  → { transaction_id }
//   … Glovo FETCHES menuUrl from us, asynchronously …
//   GET  /webhook/stores/{storeId}/menu/{transaction_id} → SUCCESS | PROCESSING | FETCH_MENU_* | …
//
// So we serve the menu JSON ourselves, at a capability URL: a random token
// per publish, stored on the connection and compared in constant time. Glovo
// says it fetches with `Authorization: Bearer <token>` but not WHICH token, so
// the URL is the credential and the header is only logged (question 7 on the
// Glovo list). The URL is dead the moment the next publish rotates it.
//
// ⚠️ A FULL UPLOAD REPLACES EVERY `available` FLAG. Publishing a menu with an
// 86'd item marked available would silently put it back on sale on Glovo. So
// the feed reads the live snoozes (GLOVO + ALL channels, this location) and
// publishes those items unavailable.
//
// ⚠️ FIVE FULL UPLOADS PER DAY PER STORE ADDRESS, then 429 / LIMIT_EXCEEDED.
// Counted here over a rolling 24 hours and refused BEFORE Glovo refuses it,
// because a refused upload still spends the operator's patience. Small
// changes (price, availability) go through the item endpoints instead.

const PROD_API_ORIGIN = "https://orderhub-api-0re6.onrender.com";
export const GLOVO_DAILY_UPLOAD_LIMIT = 5;

/** Statuses after which polling stops. PROCESSING is the only live one. */
const TERMINAL = new Set([
  "SUCCESS",
  "FETCH_MENU_INVALID_PAYLOAD",
  "FETCH_MENU_SERVER_ERROR",
  "FETCH_MENU_UNAUTHORIZED",
  "NOT_PROCESSED",
  "LIMIT_EXCEEDED",
  "GLOVO_ERROR",
  "SCHEDULE_CATALOG_DISABLED",
]);

export interface GlovoMenuPublishState {
  menuId?: string;
  feedToken?: string;
  transactionId?: string | null;
  status?: string | null;
  details?: string[];
  sentAt?: string;
  lastCheckedAt?: string | null;
  uploads?: string[];
  fetchedAt?: string | null;
}

/** Uploads in the last 24 hours, newest last. */
export function uploadsInLastDay(uploads: unknown, now = Date.now()): string[] {
  const list = Array.isArray(uploads) ? uploads.map(String) : [];
  return list.filter((iso) => {
    const t = Date.parse(iso);
    return Number.isFinite(t) && now - t < 24 * 3600_000;
  });
}

@Injectable()
export class GlovoMenuPublishService {
  private readonly logger = new Logger(GlovoMenuPublishService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly client: GlovoClientService,
    private readonly config: ConfigService,
    private readonly variantResolver: VariantPriceResolverService,
    @Optional() private readonly activity?: ActivityLogService,
  ) {}

  private apiOrigin(): string {
    const raw = this.config.get<string>("app.apiUrl") ?? "";
    // Glovo's servers fetch this, and only over HTTPS.
    if (!raw || raw.includes("localhost") || !raw.startsWith("https://")) return PROD_API_ORIGIN;
    return raw.replace(/\/+$/, "");
  }

  feedUrl(connectionId: string, token: string): string {
    return `${this.apiOrigin()}/api/v1/integrations/glovo/menu-feed/${connectionId}/${token}.json`;
  }

  private absolutiseImage(url?: string | null): string | null {
    const u = (url ?? "").trim();
    if (!u || u.startsWith("data:")) return null;
    if (/^https:\/\//i.test(u)) return u;
    if (u.startsWith("/")) return `${this.apiOrigin()}${u}`;
    // http:// is rejected by Glovo's schema; publishing no image beats a broken one.
    return null;
  }

  // ── Publish ────────────────────────────────────────────────────────────

  async publishMenu(args: { tenantId: string; menuId: string; locationId?: string }) {
    const { tenantId, menuId } = args;
    const menu = await this.prisma.menu.findFirst({
      where: { id: menuId, brand: { tenantId }, deletedAt: null },
      select: { id: true, name: true, brandId: true, locationId: true },
    });
    if (!menu) throw new BadRequestException("Menu not found");

    const targetLocationId = args.locationId ?? menu.locationId;
    const conn = await this.prisma.brandPlatformConnection.findFirst({
      where: {
        tenantId,
        brandId: menu.brandId,
        platform: "GLOVO",
        status: { not: "not_connected" },
        ...(targetLocationId ? { locationId: targetLocationId } : {}),
      },
      select: { id: true, locationId: true, externalStoreId: true, metadata: true },
    });
    if (!conn?.externalStoreId) {
      throw new BadRequestException(
        "Glovo isn't connected for this brand at this location. Connect it under Locations → Brands → Glovo first.",
      );
    }

    const metadata = { ...((conn.metadata as any) ?? {}) } as Record<string, any>;
    const prev: GlovoMenuPublishState = metadata.glovoMenuPublish ?? {};
    const recent = uploadsInLastDay(prev.uploads);
    if (recent.length >= GLOVO_DAILY_UPLOAD_LIMIT) {
      const next = new Date(Date.parse(recent[0]!) + 24 * 3600_000);
      throw new BadRequestException(
        `Glovo allows ${GLOVO_DAILY_UPLOAD_LIMIT} full menu uploads a day per store, and this store has used them. ` +
          `The next one is available after ${next.toISOString()}. Price and availability changes still go through immediately.`,
      );
    }

    // Build it now, so a menu Glovo would reject fails HERE with our words
    // rather than later as FETCH_MENU_INVALID_PAYLOAD.
    const built = await this.buildForConnection({
      tenantId,
      menuId,
      brandId: menu.brandId,
      locationId: conn.locationId,
    });
    if (built.menu.products.length === 0) {
      throw new BadRequestException(
        "Nothing on this menu can be published to Glovo (no visible products with a price above 0).",
      );
    }

    const feedToken = crypto.randomBytes(24).toString("hex");
    const state: GlovoMenuPublishState = {
      menuId,
      feedToken,
      transactionId: null,
      status: "SENDING",
      details: [],
      sentAt: new Date().toISOString(),
      lastCheckedAt: null,
      fetchedAt: null,
      uploads: [...recent, new Date().toISOString()],
    };
    // Written BEFORE the upload: Glovo may fetch the feed before our POST even
    // returns, and the feed only answers for the current token.
    await this.saveState(conn.id, state);

    const logCtx = {
      tenantId,
      brandId: menu.brandId,
      locationId: conn.locationId,
      category: "MENU" as const,
      channel: "GLOVO",
      action: "menu.publish",
    };

    let transactionId: string | null = null;
    try {
      const res = await this.client.request<{ transaction_id?: string }>(
        "POST",
        `/webhook/stores/${encodeURIComponent(conn.externalStoreId)}/menu`,
        { body: { menuUrl: this.feedUrl(conn.id, feedToken) }, retries: 1 },
      );
      transactionId = res?.transaction_id ?? null;
    } catch (e: any) {
      const limit = e instanceof GlovoApiError && e.httpStatus === 429;
      await this.saveState(conn.id, {
        ...state,
        status: limit ? "LIMIT_EXCEEDED" : "UPLOAD_FAILED",
        details: [String(e?.message ?? e)],
        // A refused upload did not use one of the five.
        uploads: limit ? state.uploads : recent,
      });
      this.activity?.record({
        ...logCtx,
        status: "ERROR",
        message: `Menu "${menu.name}" upload to Glovo failed: ${String(e?.message ?? e)}`,
      });
      throw e;
    }

    await this.saveState(conn.id, { ...state, transactionId, status: "PROCESSING" });
    await this.prisma.menu
      .update({ where: { id: menuId }, data: { lastPublishedAt: new Date() } })
      .catch(() => undefined);

    // INFO, not SUCCESS: Glovo has only accepted the job. The transaction
    // status is the outcome, and the poller upgrades this log when it lands.
    this.activity?.record({
      ...logCtx,
      status: "INFO",
      message: `Menu "${menu.name}" sent to Glovo store ${conn.externalStoreId} — waiting for Glovo to process it`,
      details: { ...built.stats, transactionId, warnings: built.warnings },
    });
    this.logger.log(
      `Glovo menu ${menuId} → store ${conn.externalStoreId}: tx=${transactionId} ` +
        `${built.stats.collections} collections / ${built.stats.products} products / ` +
        `${built.stats.attributeGroups} groups / ${built.stats.attributes} attributes`,
    );

    return {
      ok: true,
      pending: true,
      storeId: conn.externalStoreId,
      transactionId,
      uploadsLeftToday: GLOVO_DAILY_UPLOAD_LIMIT - state.uploads!.length,
      ...built.stats,
      warnings: built.warnings,
    };
  }

  // ── The feed Glovo fetches ─────────────────────────────────────────────

  /**
   * Serve the menu JSON for the current publish. Public (Glovo cannot log in),
   * so the token in the URL is the whole of the access check: a wrong or
   * rotated token is a 404, indistinguishable from a connection that does not
   * exist.
   */
  async serveFeed(args: {
    connectionId: string;
    token: string;
    authorization?: string;
  }): Promise<GlovoMenu> {
    const conn = await this.prisma.brandPlatformConnection.findFirst({
      where: { id: args.connectionId, platform: "GLOVO", status: { not: "not_connected" } },
      select: { id: true, tenantId: true, brandId: true, locationId: true, metadata: true },
    });
    const state: GlovoMenuPublishState = ((conn?.metadata as any) ?? {}).glovoMenuPublish ?? {};
    const expected = String(state.feedToken ?? "");
    const presented = String(args.token ?? "").replace(/\.json$/i, "");
    const ok =
      !!conn &&
      !!expected &&
      expected.length === presented.length &&
      crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(presented));
    if (!ok || !state.menuId) throw new NotFoundException();

    // What Glovo actually sends, so question 7 is answered by the wire.
    const auth = String(args.authorization ?? "");
    this.logger.log(
      `Glovo fetched menu feed for connection ${conn!.id} (auth header: ${
        !auth ? "none" : /^Bearer\s/i.test(auth) ? "Bearer <redacted>" : "present, no Bearer"
      })`,
    );

    const built = await this.buildForConnection({
      tenantId: conn!.tenantId,
      menuId: state.menuId,
      brandId: conn!.brandId,
      locationId: conn!.locationId,
    });
    await this.saveState(conn!.id, { ...state, fetchedAt: new Date().toISOString() });
    return built.menu;
  }

  // ── Transaction status ─────────────────────────────────────────────────

  async checkStatus(tenantId: string, connectionId: string) {
    const conn = await this.prisma.brandPlatformConnection.findFirst({
      where: { id: connectionId, tenantId, platform: "GLOVO" },
      select: {
        id: true,
        tenantId: true,
        brandId: true,
        locationId: true,
        externalStoreId: true,
        metadata: true,
      },
    });
    if (!conn) throw new NotFoundException("Glovo connection not found");
    return this.pollOne(conn);
  }

  /** Poll every in-flight upload. Glovo keeps a transaction's status 24h. */
  @Cron("0 * * * * *")
  async pollInFlight(): Promise<void> {
    if (!this.client.configured) return;
    const rows = await this.prisma.brandPlatformConnection
      .findMany({
        where: {
          platform: "GLOVO",
          metadata: { path: ["glovoMenuPublish", "status"], equals: "PROCESSING" },
        },
        select: {
          id: true,
          tenantId: true,
          brandId: true,
          locationId: true,
          externalStoreId: true,
          metadata: true,
        },
        take: 50,
      })
      .catch(() => []);
    for (const row of rows) {
      await this.pollOne(row).catch((e) =>
        this.logger.warn(`Glovo menu status poll failed for ${row.id}: ${e?.message}`),
      );
    }
  }

  private async pollOne(conn: {
    id: string;
    tenantId: string;
    brandId: string;
    locationId: string;
    externalStoreId: string | null;
    metadata: unknown;
  }) {
    const state: GlovoMenuPublishState = ((conn.metadata as any) ?? {}).glovoMenuPublish ?? {};
    if (!state.transactionId || !conn.externalStoreId) {
      return { status: state.status ?? null, details: state.details ?? [] };
    }
    if (state.status && TERMINAL.has(state.status)) {
      return { status: state.status, details: state.details ?? [] };
    }
    // Past Glovo's 24-hour retention the answer is a 404 forever.
    if (state.sentAt && Date.now() - Date.parse(state.sentAt) > 24 * 3600_000) {
      await this.saveState(conn.id, { ...state, status: "EXPIRED" });
      return { status: "EXPIRED", details: state.details ?? [] };
    }

    const res = await this.client.request<{
      status?: string;
      details?: string[];
      last_updated_at?: string;
    }>(
      "GET",
      `/webhook/stores/${encodeURIComponent(conn.externalStoreId)}/menu/${encodeURIComponent(state.transactionId)}`,
    );
    const status = String(res?.status ?? "PROCESSING");
    const details = Array.isArray(res?.details) ? res!.details.map(String) : [];
    await this.saveState(conn.id, {
      ...state,
      status,
      details,
      lastCheckedAt: new Date().toISOString(),
    });

    if (status !== "PROCESSING" && status !== state.status) {
      const ok = status === "SUCCESS";
      this.activity?.record({
        tenantId: conn.tenantId,
        brandId: conn.brandId,
        locationId: conn.locationId,
        category: "MENU",
        channel: "GLOVO",
        action: "menu.publish_result",
        status: ok ? "SUCCESS" : "ERROR",
        message: ok
          ? `Glovo accepted the menu for store ${conn.externalStoreId}`
          : `Glovo rejected the menu for store ${conn.externalStoreId}: ${status}` +
            (details.length ? ` — ${details.slice(0, 3).join("; ")}` : ""),
        details: { transactionId: state.transactionId, status, details },
      });
    }
    return { status, details };
  }

  // ── Menu graph → transformer source ────────────────────────────────────

  async buildForConnection(args: {
    tenantId: string;
    menuId: string;
    brandId: string;
    locationId: string;
  }) {
    const variantMap = await this.variantResolver.forBrandChannel({
      brandId: args.brandId,
      channel: "GLOVO",
    });
    const categories = await this.loadCategories(args.tenantId, args.menuId, args.locationId, variantMap);
    return buildGlovoMenu({ categories });
  }

  /** Items 86'd on Glovo (or everywhere) at this location right now. */
  private async snoozedItemIds(itemIds: string[], locationId: string): Promise<Set<string>> {
    if (itemIds.length === 0) return new Set();
    const now = new Date();
    const rows = await (this.prisma as any).menuItemChannelAvailability.findMany({
      where: {
        channel: { in: ["GLOVO", "ALL"] },
        itemId: { in: itemIds },
        AND: [
          { OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] },
          { OR: [{ locationId: null }, { locationId }] },
        ],
      },
      select: { itemId: true },
    });
    return new Set(rows.map((r: any) => String(r.itemId)));
  }

  private async loadCategories(
    tenantId: string,
    menuId: string,
    locationId: string,
    variantMap: VariantPriceMap | null,
  ): Promise<GlovoSrcCategory[]> {
    const cats = await this.prisma.menuCategory.findMany({
      where: { menuId, isVisible: true, menu: { brand: { tenantId } } },
      orderBy: { sortOrder: "asc" },
      include: { items: { orderBy: { sortOrder: "asc" }, include: { item: true } } },
    });

    const singleItemIds = new Set<string>();
    const skuGroupIds = new Set<string>();
    const skusByItem = new Map<string, ProductSku[]>();
    const allItemIds: string[] = [];
    for (const c of cats) {
      for (const link of c.items) {
        const it = link.item;
        if (!link.isVisible || !it) continue;
        allItemIds.push(it.id);
        const skus = this.readSkus(it);
        if (skus.length > 0) {
          skusByItem.set(it.id, skus);
          for (const s of skus) for (const gid of s.modifierGroups ?? []) skuGroupIds.add(gid);
        } else {
          singleItemIds.add(it.id);
        }
      }
    }

    const [groupsByItem, groupsById, snoozed] = await Promise.all([
      this.loadGroupsByItem(tenantId, Array.from(singleItemIds), variantMap),
      this.loadGroupsById(tenantId, Array.from(skuGroupIds)),
      this.snoozedItemIds(allItemIds, locationId),
    ]);

    return cats.map((c) => ({
      id: c.id,
      name: c.name,
      products: c.items
        .filter((l) => l.isVisible && !!l.item && (variantMap?.appliesToItem(l.item) ?? true))
        .flatMap((l) => this.toSrcProducts(l, skusByItem, groupsByItem, groupsById, variantMap, snoozed)),
    }));
  }

  private readSkus(it: any): ProductSku[] {
    if (!it?.hasMultipleSkus) return [];
    const raw = Array.isArray(it.productSkus) ? it.productSkus : [];
    return raw
      .filter((s: any) => s && typeof s.name === "string")
      .map((s: any) => ({
        name: String(s.name),
        plu: s.plu ? String(s.plu) : "",
        price: Number(s.price) || 0,
        modifierGroups: Array.isArray(s.modifierGroups) ? s.modifierGroups.map(String) : [],
        priceOverrides: s.priceOverrides ?? undefined,
      }));
  }

  /**
   * One menu item → one Glovo product, or one per size.
   *
   * Glovo has no sizes and no nested groups, so this is the same decision
   * Deliveroo and Uber make (integrations/shared/publish-sizes): ONE product +
   * a required size group whenever the menu can be said that way faithfully,
   * one product per size only when a modifier's price or availability depends
   * on the size. Deliveroo's third, nested, shape is not open to us.
   *
   * Product ids MUST match glovoProductIdsFor() — the 86 pushes by them.
   */
  private toSrcProducts(
    link: any,
    skusByItem: Map<string, ProductSku[]>,
    groupsByItem: Map<string, GlovoSrcGroup[]>,
    groupsById: Map<string, any>,
    variantMap: VariantPriceMap | null,
    snoozed: Set<string>,
  ): GlovoSrcProduct[] {
    const it = link.item;
    const imageUrl = this.absolutiseImage(it.imageUrl);
    const available = it.isAvailable !== false && it.outOfStock !== true && !snoozed.has(it.id);
    const skus = skusByItem.get(it.id);

    const toGroup = (g: any, sizeKey: string | null, suffix: string): GlovoSrcGroup => ({
      id: `${g.id}${suffix}`,
      name: g.name,
      minSelections: g.minSelections,
      maxSelections: g.maxSelections,
      allowDuplicateSelections: g.allowDuplicateSelections,
      options: (g.options ?? [])
        .filter((o: any) => isModifierAvailable(o, sizeKey, { audience: "customer" }))
        .map((o: any) => ({
          id: `${o.id}${suffix}`,
          name: o.name,
          price: variantMap?.optionPrice(o) ?? getModifierPrice(o, sizeKey),
          available: o.isAvailable !== false,
        })),
    });

    if (skus && skus.length > 0) {
      if (!needsPerSizeExpansion(skus, groupsById)) {
        const size = buildSizeGroup(it.id, skus);
        const groups: GlovoSrcGroup[] = [
          {
            id: size.id,
            name: size.name,
            minSelections: 1,
            maxSelections: 1,
            allowDuplicateSelections: false,
            options: size.options.map((o) => ({ id: o.id, name: o.name, price: o.price })),
          },
        ];
        for (const gid of skus[0]!.modifierGroups ?? []) {
          const g = groupsById.get(gid);
          if (!g) continue;
          const grp = toGroup(g, null, "");
          if (grp.options.length) groups.push(grp);
        }
        return [
          {
            id: it.id,
            name: it.name,
            description: it.description ?? null,
            price: sizeBasePrice(skus),
            imageUrl,
            available,
            groups,
          },
        ];
      }

      return skus.map((sku, i) => {
        const sizeKey = extractSizeKey(sku.name) ?? sku.name;
        const slug = `__${String(sizeKey).replace(/[^a-z0-9]+/gi, "-").toLowerCase() || "x"}`;
        const groups: GlovoSrcGroup[] = [];
        for (const gid of sku.modifierGroups ?? []) {
          const g = groupsById.get(gid);
          if (!g) continue;
          const grp = toGroup(g, sizeKey, slug);
          if (grp.options.length) groups.push(grp);
        }
        return {
          id: `${it.id}__s${i}`,
          name: `${it.name} - ${sku.name}`,
          description: it.description ?? null,
          price: variantMap?.skuPrice(it, sku) ?? (Number(sku.price) || 0),
          imageUrl,
          available,
          groups,
        };
      });
    }

    const price =
      variantMap?.itemPrice(it) ??
      (link.priceOverride != null ? Number(link.priceOverride) : Number(it.basePrice));
    return [
      {
        id: it.id,
        name: it.name,
        description: it.description ?? null,
        price,
        imageUrl,
        available,
        groups: groupsByItem.get(it.id) ?? [],
      },
    ];
  }

  /** SKU groups are bare ids (no FK) — resolved by id AND tenant, never brand-listed. */
  private async loadGroupsById(tenantId: string, groupIds: string[]): Promise<Map<string, any>> {
    const out = new Map<string, any>();
    if (groupIds.length === 0) return out;
    const groups = await this.prisma.modifierGroup.findMany({
      where: { id: { in: groupIds }, brand: { tenantId } },
      include: { options: { where: { isAvailable: true }, orderBy: { sortOrder: "asc" } } },
    });
    for (const g of groups) out.set(g.id, g);
    return out;
  }

  private async loadGroupsByItem(
    tenantId: string,
    itemIds: string[],
    variantMap: VariantPriceMap | null,
  ): Promise<Map<string, GlovoSrcGroup[]>> {
    const out = new Map<string, GlovoSrcGroup[]>();
    if (itemIds.length === 0) return out;
    const links = await this.prisma.modifierGroupOnItem.findMany({
      where: { itemId: { in: itemIds }, group: { brand: { tenantId } } },
      orderBy: { sortOrder: "asc" },
      include: {
        group: {
          include: { options: { where: { isAvailable: true }, orderBy: { sortOrder: "asc" } } },
        },
      },
    });
    for (const link of links) {
      const g = link.group;
      if (!g) continue;
      const arr = out.get(link.itemId) ?? [];
      arr.push({
        id: g.id,
        name: g.name,
        minSelections: g.minSelections,
        maxSelections: g.maxSelections,
        allowDuplicateSelections: g.allowDuplicateSelections,
        options: (g.options ?? []).map((o: any) => ({
          id: o.id,
          name: o.name,
          price: variantMap?.optionPrice(o) ?? Number(o.priceAdjustment),
          available: o.isAvailable !== false,
        })),
      });
      out.set(link.itemId, arr);
    }
    return out;
  }

  private async saveState(connectionId: string, state: GlovoMenuPublishState): Promise<void> {
    try {
      const conn = await this.prisma.brandPlatformConnection.findUnique({
        where: { id: connectionId },
        select: { metadata: true },
      });
      const metadata = { ...((conn?.metadata as any) ?? {}), glovoMenuPublish: state };
      await this.prisma.brandPlatformConnection.update({
        where: { id: connectionId },
        data: { metadata: metadata as any, lastSyncAt: new Date() },
      });
    } catch (e: any) {
      this.logger.warn(`Glovo publish bookkeeping failed: ${e?.message}`);
    }
  }
}
