import { BadRequestException, Injectable, Logger, NotFoundException, Optional } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import {
  currencyForCountry,
  extractSizeKey,
  getModifierPrice,
  isModifierAvailable,
  type ProductSku,
} from "@orderhub/shared";
import { PrismaService } from "../../../infrastructure/database/prisma.service";
import { ActivityLogService } from "../../logs/activity-log.service";
import {
  VariantPriceResolverService,
  type VariantPriceMap,
} from "../../menus/variant-price-resolver.service";
import { KeetaAuthService } from "./keeta-auth.service";
import { KeetaApiError, KeetaClientService } from "./keeta-client.service";
import { kInt, keetaId } from "./keeta-json";
import {
  buildKeetaMenuSync,
  type KeetaMenuBuild,
  type KeetaSrcCategory,
  type KeetaSrcGroup,
  type KeetaSrcItem,
  type KeetaSrcMenu,
} from "./keeta-menu.transformer";

// Phase KT-4 — publish an OrderHub menu to a Keeta store.
//
//   POST /product/menu/sync  { shopId, shopCategoryList, choiceGroupList,
//                              spuList, spuSequenceCodeMap }  → data: taskId
//   … Keeta process it asynchronously …
//   webhook 1202  { shopId, taskId, errorSpuDTOList[] }   (and 1201 for images)
//
// ⚠️ A FULL REPLACE. Anything missing from the payload is deleted from the
// Keeta store, and 86'd items must be SENT as unavailable or the publish puts
// them back on sale — so live snoozes (KEETA + ALL) are read here.
//
// ⚠️ API sync LOCKS the Keeta merchant portal's menu editor for the store.
// Once a shop publishes from OrderHub, OrderHub is where its Keeta menu lives.

const PROD_API_ORIGIN = "https://orderhub-api-0re6.onrender.com";

export interface KeetaMenuPublishState {
  menuId?: string;
  taskId?: string | null;
  status?: "PROCESSING" | "SUCCESS" | "PARTIAL" | "FAILED" | "SEND_FAILED";
  sentAt?: string;
  finishedAt?: string | null;
  errors?: Array<{ name?: string; code?: string; message?: string }>;
  pictureErrors?: Array<{ url?: string; message?: string }>;
  warnings?: string[];
  stats?: KeetaMenuBuild["stats"];
}

@Injectable()
export class KeetaMenuPublishService {
  private readonly logger = new Logger(KeetaMenuPublishService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly client: KeetaClientService,
    private readonly auth: KeetaAuthService,
    private readonly config: ConfigService,
    private readonly variantResolver: VariantPriceResolverService,
    @Optional() private readonly activity?: ActivityLogService,
  ) {}

  private apiOrigin(): string {
    const raw = this.config.get<string>("app.apiUrl") ?? "";
    if (!raw || raw.includes("localhost")) return PROD_API_ORIGIN;
    return raw.replace(/\/+$/, "");
  }

  /** Keeta fetch images themselves, so a relative path must become absolute. */
  private absoluteImage(url?: string | null): string | null {
    const u = String(url ?? "").trim();
    if (!u || u.startsWith("data:")) return null;
    if (/^https?:\/\//i.test(u)) return u;
    if (u.startsWith("/")) return `${this.apiOrigin()}${u}`;
    return null;
  }

  private async connectionFor(tenantId: string, brandId: string, locationId?: string | null) {
    const conn = await this.prisma.brandPlatformConnection.findFirst({
      where: {
        tenantId,
        brandId,
        platform: "KEETA",
        status: { not: "not_connected" },
        externalStoreId: { not: null },
        ...(locationId ? { locationId } : {}),
      },
      select: {
        id: true,
        tenantId: true,
        brandId: true,
        locationId: true,
        externalStoreId: true,
        metadata: true,
        location: { select: { country: true } },
      },
    });
    if (!conn?.externalStoreId) {
      throw new BadRequestException(
        "Keeta isn't connected for this brand at this location. Connect it under Locations → Brands → Keeta first.",
      );
    }
    return conn;
  }

  /** Build without sending — every rule Keeta would reject on, checked here. */
  async dryRun(args: { tenantId: string; menuId: string; locationId?: string }) {
    const menu = await this.loadMenuRow(args.tenantId, args.menuId);
    const conn = await this.connectionFor(args.tenantId, menu.brandId, args.locationId ?? menu.locationId);
    const built = await this.build(args.tenantId, menu, conn);
    return { ...built, shopId: conn.externalStoreId };
  }

  async publishMenu(args: { tenantId: string; menuId: string; locationId?: string }) {
    const menu = await this.loadMenuRow(args.tenantId, args.menuId);
    const conn = await this.connectionFor(args.tenantId, menu.brandId, args.locationId ?? menu.locationId);
    const built = await this.build(args.tenantId, menu, conn);

    const logCtx = {
      tenantId: args.tenantId,
      brandId: menu.brandId,
      locationId: conn.locationId,
      category: "MENU" as const,
      channel: "KEETA",
      action: "menu.publish",
    };

    if (!built.payload) {
      this.activity?.record({
        ...logCtx,
        status: "ERROR",
        message: `Menu "${menu.name}" was not sent to Keeta — ${built.errors.length} problem(s) to fix first`,
        details: { errors: built.errors.slice(0, 30) },
      });
      return { ok: false, errors: built.errors, warnings: built.warnings, stats: built.stats };
    }

    const token = await this.auth.tokenForConnection(conn);
    let taskId: string | null = null;
    try {
      const data = await this.client.request<unknown>(
        "/product/menu/sync",
        { shopId: kInt(conn.externalStoreId!), ...built.payload },
        { accessToken: token, retries: 1, timeoutMs: 60_000 },
      );
      taskId = keetaId(typeof data === "object" && data ? (data as any).taskId ?? null : data);
    } catch (e: any) {
      const msg = e instanceof KeetaApiError ? `${e.keetaCode}: ${e.keetaMessage}` : String(e?.message ?? e);
      await this.saveState(conn.id, {
        menuId: menu.id,
        taskId: null,
        status: "SEND_FAILED",
        sentAt: new Date().toISOString(),
        errors: [{ message: msg }],
        warnings: built.warnings.map((w) => `${w.name ?? w.code}: ${w.message}`),
        stats: built.stats,
      });
      this.activity?.record({ ...logCtx, status: "ERROR", message: `Menu "${menu.name}" upload to Keeta failed: ${msg}` });
      throw e;
    }

    await this.saveState(conn.id, {
      menuId: menu.id,
      taskId,
      status: "PROCESSING",
      sentAt: new Date().toISOString(),
      finishedAt: null,
      errors: [],
      pictureErrors: [],
      warnings: built.warnings.map((w) => `${w.name ?? w.code}: ${w.message}`),
      stats: built.stats,
    });
    await this.prisma.menu
      .update({ where: { id: menu.id }, data: { lastPublishedAt: new Date() } })
      .catch(() => undefined);

    // INFO, not SUCCESS: Keeta have only accepted the task. Webhook 1202 is
    // the outcome, and it upgrades this.
    this.activity?.record({
      ...logCtx,
      status: "INFO",
      message:
        `Menu "${menu.name}" sent to Keeta store ${conn.externalStoreId} — ${built.stats.spus} products, ` +
        `waiting for Keeta to process it`,
      details: { taskId, ...built.stats, warnings: built.warnings.slice(0, 20) },
    });
    this.logger.log(`Keeta menu ${menu.id} → shop ${conn.externalStoreId}: task ${taskId}`);
    return { ok: true, pending: true, taskId, shopId: conn.externalStoreId, stats: built.stats, warnings: built.warnings };
  }

  /** 1202 — the menu sync task finished. */
  async onMenuSyncResult(msg: { shopId?: unknown; taskId?: unknown; errorSpuDTOList?: any[] }) {
    const shopId = keetaId(msg.shopId);
    if (!shopId) return;
    const conns = await this.prisma.brandPlatformConnection.findMany({
      where: { platform: "KEETA", externalStoreId: shopId },
      select: { id: true, tenantId: true, brandId: true, locationId: true, metadata: true },
    });
    const errs = (msg.errorSpuDTOList ?? []).map((e: any) => ({
      name: e?.name ?? undefined,
      code: e?.openItemCode ?? undefined,
      message: `${e?.code ?? ""} ${e?.message ?? ""}`.trim(),
    }));
    for (const c of conns) {
      const prev: KeetaMenuPublishState = ((c.metadata as any) ?? {}).keetaMenuPublish ?? {};
      // A result for a task that is not the latest one says nothing about
      // what is live now.
      if (prev.taskId && keetaId(msg.taskId) && prev.taskId !== keetaId(msg.taskId)) continue;
      const status = errs.length ? "PARTIAL" : "SUCCESS";
      await this.saveState(c.id, { ...prev, status, errors: errs, finishedAt: new Date().toISOString() });
      this.activity?.record({
        tenantId: c.tenantId,
        brandId: c.brandId,
        locationId: c.locationId,
        category: "MENU",
        channel: "KEETA",
        action: "menu.publish_result",
        status: errs.length ? "ERROR" : "SUCCESS",
        message: errs.length
          ? `Keeta rejected ${errs.length} product(s) from the menu: ` +
            errs.slice(0, 3).map((e) => `${e.name ?? e.code} (${e.message})`).join("; ")
          : `Keeta accepted the menu for store ${shopId}`,
        details: { taskId: keetaId(msg.taskId), errors: errs.slice(0, 50) },
      });
    }
  }

  /** 1201 — the image part of a sync finished. Image rejections only. */
  async onPictureResult(msg: { shopId?: unknown; errorPictureDTOList?: any[]; [k: string]: any }) {
    const shopId = keetaId(msg.shopId);
    if (!shopId) return;
    const list: any[] =
      msg.errorPictureDTOList ?? msg.errorPictureList ?? msg.errorList ?? msg.failList ?? [];
    if (!Array.isArray(list) || list.length === 0) return;
    const pictureErrors = list.map((e: any) => ({
      url: e?.url ?? e?.pictureUrl ?? undefined,
      message: `${e?.code ?? ""} ${e?.message ?? ""}`.trim(),
    }));
    const conns = await this.prisma.brandPlatformConnection.findMany({
      where: { platform: "KEETA", externalStoreId: shopId },
      select: { id: true, tenantId: true, brandId: true, locationId: true, metadata: true },
    });
    for (const c of conns) {
      const prev: KeetaMenuPublishState = ((c.metadata as any) ?? {}).keetaMenuPublish ?? {};
      await this.saveState(c.id, { ...prev, pictureErrors });
      this.activity?.record({
        tenantId: c.tenantId,
        brandId: c.brandId,
        locationId: c.locationId,
        category: "MENU",
        channel: "KEETA",
        action: "menu.pictures",
        status: "WARNING",
        message:
          `Keeta rejected ${pictureErrors.length} product photo(s) — they need to be at least 600×450, under 5MB` +
          (pictureErrors[0]?.message ? ` (${pictureErrors[0].message})` : ""),
        details: { pictureErrors: pictureErrors.slice(0, 30) },
      });
    }
  }

  // ── loading ─────────────────────────────────────────────────────────────

  private async loadMenuRow(tenantId: string, menuId: string) {
    const menu = await this.prisma.menu.findFirst({
      where: { id: menuId, brand: { tenantId }, deletedAt: null },
      select: { id: true, name: true, brandId: true, locationId: true },
    });
    if (!menu) throw new NotFoundException("Menu not found");
    return menu;
  }

  private async build(
    tenantId: string,
    menu: { id: string; brandId: string },
    conn: { locationId: string; externalStoreId: string | null; location?: { country: string | null } | null },
  ): Promise<KeetaMenuBuild> {
    const variantMap = await this.variantResolver.forBrandChannel({ brandId: menu.brandId, channel: "KEETA" });
    const src = await this.loadSource(tenantId, menu.id, conn, variantMap);
    return buildKeetaMenuSync(src);
  }

  /** Items 86'd on Keeta (or everywhere) at this location right now. */
  private async snoozedItemIds(itemIds: string[], locationId: string): Promise<Set<string>> {
    if (itemIds.length === 0) return new Set();
    const now = new Date();
    const rows = await (this.prisma as any).menuItemChannelAvailability
      .findMany({
        where: {
          channel: { in: ["KEETA", "ALL"] },
          itemId: { in: itemIds },
          AND: [
            { OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] },
            { OR: [{ locationId: null }, { locationId }] },
          ],
        },
        select: { itemId: true },
      })
      .catch(() => []);
    return new Set(rows.map((r: any) => String(r.itemId)));
  }

  async loadSource(
    tenantId: string,
    menuId: string,
    conn: { locationId: string; externalStoreId: string | null; location?: { country: string | null } | null },
    variantMap: VariantPriceMap | null,
  ): Promise<KeetaSrcMenu> {
    const cats = await this.prisma.menuCategory.findMany({
      where: { menuId, isVisible: true, menu: { brand: { tenantId } } },
      orderBy: { sortOrder: "asc" },
      include: { items: { orderBy: { sortOrder: "asc" }, include: { item: true } } },
    });

    const links = cats.flatMap((c) =>
      c.items.filter(
        (l) =>
          (l as any).isVisible !== false &&
          !!l.item &&
          l.item.visibleToCustomers !== false &&
          (variantMap?.appliesToItem(l.item as any) ?? true),
      ),
    );
    const itemRows = new Map<string, any>();
    for (const l of links) itemRows.set(l.item!.id, { ...l.item, _priceOverride: (l as any).priceOverride });
    const snoozed = await this.snoozedItemIds(Array.from(itemRows.keys()), conn.locationId);

    // Which groups: item-level links for single-size items, per-SKU lists
    // (bare ids, no FK — resolved by id AND tenant) for sized ones.
    const skusByItem = new Map<string, ProductSku[]>();
    const singleItemIds: string[] = [];
    const directGroupIds = new Set<string>();
    for (const it of itemRows.values()) {
      const skus = readSkus(it);
      if (skus.length) {
        skusByItem.set(it.id, skus);
        for (const s of skus) for (const g of s.modifierGroups ?? []) directGroupIds.add(g);
      } else {
        singleItemIds.push(it.id);
      }
    }
    const itemGroupLinks = singleItemIds.length
      ? await this.prisma.modifierGroupOnItem.findMany({
          where: { itemId: { in: singleItemIds }, group: { brand: { tenantId } } },
          orderBy: { sortOrder: "asc" },
          select: { itemId: true, groupId: true },
        })
      : [];
    const groupIdsByItem = new Map<string, string[]>();
    for (const l of itemGroupLinks) {
      groupIdsByItem.set(l.itemId, [...(groupIdsByItem.get(l.itemId) ?? []), l.groupId]);
      directGroupIds.add(l.groupId);
    }
    const groupRows = await this.loadGroupsDeep(tenantId, Array.from(directGroupIds));

    // Build groups lazily, one per (group, size-signature). A group whose
    // option prices/availability don't change with size is published ONCE
    // under its own id; one that does gets a copy per size.
    const groups = new Map<string, KeetaSrcGroup>();
    const optionPrice = (o: any, sizeKey: string | null) =>
      sizeKey ? getModifierPrice(o, sizeKey) : (variantMap?.optionPrice(o) ?? getModifierPrice(o, null));
    const shape = (g: any, sizeKey: string | null) =>
      (g.options ?? [])
        .filter((o: any) => isModifierAvailable(o, sizeKey, { audience: "customer" }))
        .map((o: any) => `${o.id}:${optionPrice(o, sizeKey)}`)
        .join("|");

    const groupCode = (gid: string, sizeKey: string | null): string | null => {
      const g = groupRows.get(gid);
      if (!g) return null;
      const sized = sizeKey != null && shape(g, sizeKey) !== shape(g, null);
      const suffix = sized ? `__${slug(sizeKey!)}` : "";
      const code = `${gid}${suffix}`;
      if (!groups.has(code)) {
        // Registered before its options are walked, so a cycle in nested
        // groups terminates instead of recursing for ever.
        const entry: KeetaSrcGroup = {
          code,
          name: g.name,
          secondLanguageName: g.secondLanguageName,
          minSelections: g.minSelections ?? 0,
          maxSelections: g.maxSelections ?? null,
          allowDuplicateSelections: !!g.allowDuplicateSelections,
          options: [],
        };
        groups.set(code, entry);
        entry.options = (g.options ?? [])
          .filter((o: any) => isModifierAvailable(o, sized ? sizeKey : null, { audience: "customer" }))
          .map((o: any) => {
            const nestedIds = Array.from(
              new Set<string>([
                ...(((o.modifierGroupIds ?? []) as string[]) || []),
                ...((o.nestedGroupLinks ?? []).map((l: any) => l.groupId) as string[]),
              ]),
            );
            return {
              code: `${o.id}${suffix}`,
              name: o.name,
              secondLanguageName: o.secondLanguageName,
              price: optionPrice(o, sized ? sizeKey : null),
              available: o.isAvailable !== false,
              groupCodes: nestedIds.map((id) => groupCode(id, null)).filter((c): c is string => !!c),
            };
          });
      }
      return code;
    };

    const items: KeetaSrcItem[] = [];
    for (const it of itemRows.values()) {
      const available = it.isAvailable !== false && it.outOfStock !== true && !snoozed.has(it.id);
      const skus = skusByItem.get(it.id);
      const common = {
        code: it.id,
        name: it.name,
        secondLanguageName: it.secondLanguageName,
        description: it.description,
        imageUrl: this.absoluteImage(it.imageUrl),
        available,
        pickup: it.availableCollection !== false,
        delivery: it.availableDelivery !== false,
        allergens: it.allergens ?? [],
        calories: it.calories ?? null,
      };
      if (skus?.length) {
        items.push({
          ...common,
          skus: skus.map((s, i) => {
            const sizeKey = extractSizeKey(s.name) ?? s.name;
            return {
              code: `${it.id}__s${i}`,
              spec: s.name,
              price: variantMap?.skuPrice(it, s) ?? (Number(s.price) || 0),
              groupCodes: (s.modifierGroups ?? [])
                .map((gid) => groupCode(gid, sizeKey))
                .filter((c): c is string => !!c),
            };
          }),
        });
      } else {
        const price =
          variantMap?.itemPrice(it) ??
          (it._priceOverride != null ? Number(it._priceOverride) : Number(it.basePrice));
        items.push({
          ...common,
          skus: [
            {
              // The SKU shares the SPU's code: uniqueness is per entity type.
              code: it.id,
              spec: "",
              price,
              groupCodes: (groupIdsByItem.get(it.id) ?? [])
                .map((gid) => groupCode(gid, null))
                .filter((c): c is string => !!c),
            },
          ],
        });
      }
    }

    const categories: KeetaSrcCategory[] = cats.map((c) => ({
      code: c.id,
      name: c.name,
      secondLanguageName: (c as any).secondLanguageName ?? null,
      description: c.description,
      itemCodes: c.items
        .filter((l) => l.item && itemRows.has(l.item.id))
        .map((l) => l.item!.id)
        .filter((id, i, arr) => arr.indexOf(id) === i),
    }));

    const country = conn.location?.country ?? "AE";
    return {
      shopId: conn.externalStoreId ?? "",
      currency: currencyForCountry(country),
      categories,
      items,
      groups: Array.from(groups.values()),
    };
  }

  /** Groups by id (and tenant), following nested option groups down. */
  private async loadGroupsDeep(tenantId: string, ids: string[]): Promise<Map<string, any>> {
    const out = new Map<string, any>();
    let frontier = Array.from(new Set(ids));
    for (let depth = 0; frontier.length && depth < 6; depth++) {
      const rows = await this.prisma.modifierGroup.findMany({
        where: { id: { in: frontier }, brand: { tenantId } },
        include: {
          options: {
            orderBy: { sortOrder: "asc" },
            include: { nestedGroupLinks: { select: { groupId: true } } },
          },
        },
      });
      const next: string[] = [];
      for (const g of rows) {
        out.set(g.id, g);
        for (const o of g.options as any[]) {
          for (const id of [
            ...((o.modifierGroupIds ?? []) as string[]),
            ...((o.nestedGroupLinks ?? []) as any[]).map((l) => l.groupId),
          ]) {
            if (!out.has(id)) next.push(id);
          }
        }
      }
      frontier = Array.from(new Set(next)).filter((id) => !out.has(id));
    }
    return out;
  }

  private async saveState(connectionId: string, state: KeetaMenuPublishState) {
    try {
      const conn = await this.prisma.brandPlatformConnection.findUnique({
        where: { id: connectionId },
        select: { metadata: true },
      });
      const metadata = { ...((conn?.metadata as any) ?? {}), keetaMenuPublish: state };
      await this.prisma.brandPlatformConnection.update({
        where: { id: connectionId },
        data: { metadata: metadata as any, lastSyncAt: new Date() },
      });
    } catch (e: any) {
      this.logger.warn(`Keeta publish bookkeeping failed: ${e?.message}`);
    }
  }
}

function readSkus(it: any): ProductSku[] {
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

function slug(s: string): string {
  return String(s).replace(/[^a-z0-9]+/gi, "-").toLowerCase().replace(/^-|-$/g, "") || "x";
}
