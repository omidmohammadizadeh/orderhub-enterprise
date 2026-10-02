import { BadRequestException, Injectable, Logger, NotFoundException, Optional } from "@nestjs/common";
import { extractSizeKey, getModifierPrice, isModifierAvailable, type ProductSku } from "@orderhub/shared";
import { PrismaService } from "../../../infrastructure/database/prisma.service";
import { hoursConfigured, toWeekHours } from "../../../common/opening-hours.util";
import { ActivityLogService } from "../../logs/activity-log.service";
import { MenuAssignmentsService } from "../../menus/menu-assignments.service";
import { VariantPriceResolverService, type VariantPriceMap } from "../../menus/variant-price-resolver.service";
import { TalabatApiError, TalabatClientService, publicApiOrigin } from "./talabat-client.service";
import { talabatSettings } from "./talabat-connection.service";
import {
  ADDONS_CATEGORY_ID,
  buildTalabatCatalog,
  talabatOptionAliases,
  type TbBuild,
  type TbSrcGroup,
  type TbSrcItem,
  type TbSrcMenu,
} from "./talabat-menu.transformer";
import type { TalabatCatalogCallback } from "./talabat-types";

// Phase TB-4 — publish a menu to a Talabat vendor.
//
//   PUT /v2/chains/{chainCode}/catalog
//   { vendors: [posVendorId], catalog: { items }, callbackUrl }
//   → 202 { status: "submitted", catalogImportId }
//
// ASYNCHRONOUS, like every marketplace's: 202 means "short validation passed",
// not "live". The middleware then validates against the JSON schema, fetches
// and checks every image, and forwards to Talabat — reporting progress to our
// callbackUrl (in_progress → done | done_with_errors | failed), and on
// GET .../menu-import-logs for 30 days.
//
// "It is only supported to push full catalogs for a vendor" — so every publish
// is the whole menu, and what we leave out disappears. That is why 86'd items
// go out INACTIVE rather than missing: a missing item has to be re-imported to
// come back, an inactive one is one availability call away.
//
// Which menu: the one the operator picked (publish modal), else the menu
// SERVING this brand on the TALABAT channel at this location (Phase BA
// assignments), else the brand's newest active menu.

export interface TalabatCatalogState {
  menuId: string;
  catalogImportId: string | null;
  status: string;
  message?: string | null;
  sentAt: string;
  finishedAt?: string | null;
  stats?: TbBuild["stats"];
  warnings?: string[];
  details?: unknown;
  /** Our option id → every catalog id it went out under (for option 86). */
  optionAliases?: Record<string, string[]>;
  /** The sellable products (MenuItem ids) that went out — the 86 targets. */
  itemIds?: string[];
}

const slug = (s: string) => String(s).replace(/[^a-z0-9]+/gi, "-").toLowerCase().replace(/^-|-$/g, "") || "x";

@Injectable()
export class TalabatMenuPublishService {
  private readonly logger = new Logger(TalabatMenuPublishService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly client: TalabatClientService,
    private readonly variantResolver: VariantPriceResolverService,
    private readonly assignments: MenuAssignmentsService,
    @Optional() private readonly activity?: ActivityLogService,
  ) {}

  // ── Which connection, which menu ───────────────────────────────────────

  async connectionFor(tenantId: string, brandId: string, locationId?: string | null) {
    const conn = await this.prisma.brandPlatformConnection.findFirst({
      where: {
        tenantId,
        brandId,
        platform: "TALABAT",
        status: { not: "not_connected" },
        externalStoreId: { not: null },
        ...(locationId ? { locationId } : {}),
      },
    });
    if (!conn?.externalStoreId) {
      throw new BadRequestException(
        "Talabat isn't connected for this brand at this location. Connect it on the Talabat page first.",
      );
    }
    return conn;
  }

  private async resolveMenu(tenantId: string, conn: { brandId: string; locationId: string }, menuId?: string) {
    let id = menuId ?? null;
    if (!id) {
      id = await this.assignments.resolveAssignedMenuId({
        locationId: conn.locationId,
        channel: "TALABAT",
        brandId: conn.brandId,
      });
    }
    if (!id) {
      const latest = await this.prisma.menu.findFirst({
        where: { brandId: conn.brandId, isActive: true, deletedAt: null },
        orderBy: { updatedAt: "desc" },
        select: { id: true },
      });
      id = latest?.id ?? null;
    }
    if (!id) throw new BadRequestException("No menu to publish — this brand has no active menu.");
    const menu = await this.prisma.menu.findFirst({
      where: { id, deletedAt: null, brand: { tenantId } },
      select: { id: true, name: true, brandId: true },
    });
    if (!menu) throw new NotFoundException("Menu not found");
    return menu;
  }

  // ── Build / publish ────────────────────────────────────────────────────

  async build(tenantId: string, connectionId: string, menuId?: string) {
    const conn = await this.prisma.brandPlatformConnection.findFirst({
      where: { id: connectionId, tenantId, platform: "TALABAT" },
    });
    if (!conn) throw new NotFoundException("Talabat connection not found");
    const menu = await this.resolveMenu(tenantId, conn, menuId);
    const variantMap = await this.variantResolver.forBrandChannel({ brandId: conn.brandId, channel: "TALABAT" });
    const src = await this.loadSource(tenantId, menu, conn, variantMap);
    const built = buildTalabatCatalog(src);
    return { conn, menu, src, built };
  }

  /** Every rule Talabat would reject on, checked — nothing sent. */
  async dryRun(tenantId: string, connectionId: string, menuId?: string) {
    const { conn, menu, built } = await this.build(tenantId, connectionId, menuId);
    return {
      menu: { id: menu.id, name: menu.name },
      remoteId: conn.externalStoreId,
      chainCode: talabatSettings(conn).chainCode ?? null,
      wouldPublish: !!built.catalog,
      problems: built.problems,
      stats: built.stats,
      catalog: built.catalog,
    };
  }

  /** Publish-modal entry point: by menu + location, like Glovo and Keeta. */
  async publishMenu(args: { tenantId: string; menuId: string; locationId?: string; brandId?: string }) {
    const menu = await this.prisma.menu.findFirst({
      where: { id: args.menuId, brand: { tenantId: args.tenantId }, deletedAt: null },
      select: { id: true, brandId: true, locationId: true },
    });
    if (!menu) throw new NotFoundException("Menu not found");
    const conn = await this.connectionFor(args.tenantId, args.brandId ?? menu.brandId, args.locationId ?? menu.locationId);
    return this.publish(args.tenantId, conn.id, menu.id);
  }

  async publish(tenantId: string, connectionId: string, menuId?: string) {
    const { conn, menu, built } = await this.build(tenantId, connectionId, menuId);
    const settings = talabatSettings(conn);
    const logCtx = {
      tenantId,
      brandId: conn.brandId,
      locationId: conn.locationId,
      category: "MENU" as const,
      channel: "TALABAT",
      action: "menu.publish",
    };
    const warnings = built.problems.filter((p) => p.level === "warning").map((p) => p.message);
    const errors = built.problems.filter((p) => p.level === "error");

    if (!built.catalog) {
      this.activity?.record({
        ...logCtx,
        status: "ERROR",
        message: `Menu "${menu.name}" was not sent to Talabat — ${errors.length} problem(s) to fix first`,
        details: { errors: errors.slice(0, 30) },
      });
      return { ok: false as const, errors, warnings, stats: built.stats };
    }
    if (!settings.chainCode) {
      throw new BadRequestException(
        "This connection has no Talabat chain code yet. Talabat assign it when they set up the chain — add it on the Talabat page.",
      );
    }

    const callbackUrl = `${publicApiOrigin()}/api/v1/talabat-plugin/catalog-callback/${conn.id}`;
    let res: { status: number; data: any };
    try {
      res = await this.client.request<any>(`/v2/chains/${encodeURIComponent(settings.chainCode)}/catalog`, {
        method: "PUT",
        body: { vendors: [conn.externalStoreId], catalog: built.catalog, callbackUrl },
        timeoutMs: 60_000,
      });
    } catch (e: any) {
      const msg = e instanceof TalabatApiError ? e.message : String(e?.message ?? e);
      await this.saveState(conn.id, {
        menuId: menu.id,
        catalogImportId: null,
        status: "SEND_FAILED",
        message: msg,
        sentAt: new Date().toISOString(),
        stats: built.stats,
        warnings,
      });
      this.activity?.record({ ...logCtx, status: "ERROR", message: `Menu "${menu.name}" upload to Talabat failed: ${msg}` });
      throw e;
    }

    const catalogImportId = String(res.data?.catalogImportId ?? "") || null;
    await this.saveState(conn.id, {
      menuId: menu.id,
      catalogImportId,
      status: String(res.data?.status ?? "submitted"),
      sentAt: new Date().toISOString(),
      finishedAt: null,
      stats: built.stats,
      warnings,
      optionAliases: talabatOptionAliases(built.catalog, suffixedRoots(built)),
      itemIds: sellableIds(built),
    });
    await this.prisma.menu
      .update({ where: { id: menu.id }, data: { lastPublishedAt: new Date() } })
      .catch(() => undefined);

    this.activity?.record({
      ...logCtx,
      status: "INFO",
      message:
        `Menu "${menu.name}" sent to Talabat (remote ID ${conn.externalStoreId}) — ${built.stats.products} products, ` +
        `waiting for Talabat to process it`,
      details: { catalogImportId, ...built.stats, warnings: warnings.slice(0, 20) },
    });
    this.logger.log(`Talabat catalog ${menu.id} → ${conn.externalStoreId}: import ${catalogImportId}`);
    return { ok: true as const, pending: true, catalogImportId, remoteId: conn.externalStoreId, stats: built.stats, warnings };
  }

  // ── Import outcome ─────────────────────────────────────────────────────

  /** POST {callbackUrl} from the middleware. */
  async onCatalogCallback(connectionId: string, body: TalabatCatalogCallback): Promise<boolean> {
    const conn = await this.prisma.brandPlatformConnection.findFirst({
      where: { id: connectionId, platform: "TALABAT" },
    });
    if (!conn) return false;
    const prev = (talabatSettings(conn).talabatCatalog ?? {}) as TalabatCatalogState;
    if (body.catalogImportId && prev.catalogImportId && body.catalogImportId !== prev.catalogImportId) {
      // A late update for an older import — the newer one is what's live.
      this.logger.log(`Talabat catalog callback for superseded import ${body.catalogImportId}`);
      return true;
    }
    const status = String(body.status ?? "unknown");
    const done = status !== "in_progress";
    await this.saveState(conn.id, {
      ...prev,
      status,
      message: body.message ?? null,
      details: body.details ?? null,
      finishedAt: done ? new Date().toISOString() : null,
    });
    if (done) {
      this.activity?.record({
        tenantId: conn.tenantId,
        brandId: conn.brandId,
        locationId: conn.locationId,
        category: "MENU",
        channel: "TALABAT",
        action: "menu.publish.result",
        status: status === "done" ? "SUCCESS" : status === "done_with_errors" ? "WARNING" : "ERROR",
        message:
          status === "done"
            ? "Talabat imported the menu — it is live"
            : status === "done_with_errors"
              ? `Talabat imported the menu with errors: ${body.message ?? "see details"}`
              : `Talabat could not import the menu: ${body.message ?? "no reason given"}`,
        details: { catalogImportId: body.catalogImportId, details: body.details },
      });
    }
    return true;
  }

  /** GET .../menu-import-logs — the last 30 days of imports for this vendor. */
  async importLogs(tenantId: string, connectionId: string) {
    const conn = await this.prisma.brandPlatformConnection.findFirst({
      where: { id: connectionId, tenantId, platform: "TALABAT" },
    });
    if (!conn?.externalStoreId) throw new NotFoundException("Talabat connection not found");
    const chain = talabatSettings(conn).chainCode;
    if (!chain) throw new BadRequestException("This connection has no chain code yet.");
    const res = await this.client.request<unknown>(
      `/v2/chains/${encodeURIComponent(chain)}/vendors/${encodeURIComponent(conn.externalStoreId)}/menu-import-logs`,
      { method: "GET", query: { limit: 20, sort: "desc" } },
    );
    return res.data;
  }

  // ── Menu graph → transformer source ────────────────────────────────────

  async loadSource(
    tenantId: string,
    menu: { id: string; name: string },
    conn: { locationId: string },
    variantMap: VariantPriceMap | null,
  ): Promise<TbSrcMenu> {
    const cats = await this.prisma.menuCategory.findMany({
      where: { menuId: menu.id, isVisible: true, menu: { brand: { tenantId } } },
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
    const rows = new Map<string, any>();
    for (const l of links) rows.set(l.item!.id, { ...l.item, _priceOverride: (l as any).priceOverride });
    const snoozed = await this.snoozedItemIds([...rows.keys()], conn.locationId);

    // Group ids: item-level links for single-size items, per-SKU lists (bare
    // ids, no FK — resolved by id AND tenant) for sized ones.
    const skusByItem = new Map<string, ProductSku[]>();
    const single: string[] = [];
    const direct = new Set<string>();
    for (const it of rows.values()) {
      const skus = readSkus(it);
      if (skus.length) {
        skusByItem.set(it.id, skus);
        for (const s of skus) for (const g of s.modifierGroups ?? []) direct.add(g);
      } else single.push(it.id);
    }
    const itemLinks = single.length
      ? await this.prisma.modifierGroupOnItem.findMany({
          where: { itemId: { in: single }, group: { brand: { tenantId } } },
          orderBy: { sortOrder: "asc" },
          select: { itemId: true, groupId: true },
        })
      : [];
    const groupIdsByItem = new Map<string, string[]>();
    for (const l of itemLinks) {
      groupIdsByItem.set(l.itemId, [...(groupIdsByItem.get(l.itemId) ?? []), l.groupId]);
      direct.add(l.groupId);
    }
    const groupRows = await this.loadGroupsDeep(tenantId, [...direct]);

    // One source group per (group, size) — a group whose prices don't vary by
    // size is published once under its own id; one that does gets a copy per
    // size (ids suffixed), exactly what Talabat's per-size second level needs.
    const groups = new Map<string, TbSrcGroup>();
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
        const entry: TbSrcGroup = {
          id: code,
          name: g.name,
          secondLanguageName: g.secondLanguageName,
          min: Math.max(0, g.minSelections ?? (g.isRequired ? 1 : 0)),
          max: g.maxSelections ?? null,
          options: [],
        };
        // Registered before its options are walked, so a cycle terminates.
        groups.set(code, entry);
        entry.options = (g.options ?? [])
          // Hidden-from-customers options never go out; out-of-stock ones go
          // out INACTIVE so a later availability call can restore them.
          .filter((o: any) => o.visibleToCustomers !== false)
          .filter((o: any) => isModifierAvailable({ ...o, isAvailable: true }, sized ? sizeKey : null, { audience: "customer" }))
          .map((o: any) => {
            const nested = [
              ...new Set<string>([
                ...((o.modifierGroupIds ?? []) as string[]),
                ...((o.nestedGroupLinks ?? []) as any[]).map((l) => l.groupId),
              ]),
            ];
            return {
              id: `${o.id}${suffix}`,
              name: o.name,
              secondLanguageName: o.secondLanguageName,
              price: optionPrice(o, sized ? sizeKey : null),
              available: o.isAvailable !== false,
              groupIds: nested.map((id) => groupCode(id, null)).filter((c): c is string => !!c),
            };
          });
      }
      return code;
    };

    const items: TbSrcItem[] = [];
    for (const it of rows.values()) {
      const available = it.isAvailable !== false && it.outOfStock !== true && !snoozed.has(it.id);
      const skus = skusByItem.get(it.id);
      const common = {
        id: it.id,
        name: it.name,
        secondLanguageName: it.secondLanguageName,
        description: it.description,
        imageUrl: absoluteImage(it.imageUrl),
        available,
        minAge: it.minAge ?? null,
        calories: it.calories ?? null,
      };
      if (skus?.length) {
        items.push({
          ...common,
          price: 0,
          groupIds: [],
          sizes: skus.map((s, i) => {
            const sizeKey = extractSizeKey(s.name) ?? s.name;
            return {
              id: `${it.id}__size${i}`,
              name: s.name,
              price: variantMap?.skuPrice(it, s) ?? (Number(s.price) || 0),
              groupIds: (s.modifierGroups ?? []).map((gid) => groupCode(gid, sizeKey)).filter((c): c is string => !!c),
            };
          }),
        });
      } else {
        items.push({
          ...common,
          price:
            variantMap?.itemPrice(it) ?? (it._priceOverride != null ? Number(it._priceOverride) : Number(it.basePrice)),
          groupIds: (groupIdsByItem.get(it.id) ?? []).map((gid) => groupCode(gid, null)).filter((c): c is string => !!c),
        });
      }
    }

    const location = await this.prisma.location.findFirst({
      where: { id: conn.locationId },
      select: { openingHours: true, brand: { select: { openingHours: true } } },
    });
    const rawHours = hoursConfigured(location?.openingHours)
      ? location?.openingHours
      : (location?.brand as { openingHours: unknown } | null)?.openingHours;

    return {
      menuId: menu.id,
      menuName: menu.name,
      categories: cats.map((c) => ({
        id: c.id,
        name: c.name,
        secondLanguageName: (c as any).secondLanguageName ?? null,
        description: c.description,
        itemIds: c.items
          .filter((l) => l.item && rows.has(l.item.id))
          .map((l) => l.item!.id)
          .filter((id, i, arr) => arr.indexOf(id) === i),
      })),
      items,
      groups,
      hours: hoursConfigured(rawHours) ? toWeekHours(rawHours) : null,
    };
  }

  private async snoozedItemIds(itemIds: string[], locationId: string): Promise<Set<string>> {
    if (!itemIds.length) return new Set();
    const now = new Date();
    const rows = await (this.prisma as any).menuItemChannelAvailability
      .findMany({
        where: {
          channel: { in: ["TALABAT", "ALL"] },
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

  private async loadGroupsDeep(tenantId: string, ids: string[]): Promise<Map<string, any>> {
    const out = new Map<string, any>();
    let frontier = [...new Set(ids)];
    for (let depth = 0; frontier.length && depth < 6; depth++) {
      const rows = await this.prisma.modifierGroup.findMany({
        where: { id: { in: frontier }, brand: { tenantId } },
        include: {
          options: { orderBy: { sortOrder: "asc" }, include: { nestedGroupLinks: { select: { groupId: true } } } },
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
      frontier = [...new Set(next)].filter((id) => !out.has(id));
    }
    return out;
  }

  private async saveState(connectionId: string, state: TalabatCatalogState) {
    try {
      const conn = await this.prisma.brandPlatformConnection.findUnique({
        where: { id: connectionId },
        select: { metadata: true },
      });
      const metadata = { ...((conn?.metadata as any) ?? {}), talabatCatalog: state };
      await this.prisma.brandPlatformConnection.update({
        where: { id: connectionId },
        data: { metadata: metadata as any, lastSyncAt: new Date() },
      });
    } catch (e: any) {
      this.logger.warn(`Talabat publish bookkeeping failed: ${e?.message}`);
    }
  }
}

/** Products listed in a real (not add-ons) category. */
function sellableIds(built: TbBuild): string[] {
  const out = new Set<string>();
  for (const [id, item] of Object.entries(built.catalog?.items ?? {})) {
    if (item.type !== "Category" || id === ADDONS_CATEGORY_ID) continue;
    for (const pid of Object.keys((item.products as object) ?? {})) out.add(pid);
  }
  return [...out];
}

/** Ids published with a "__" suffix, reduced to the id they came from. */
function suffixedRoots(built: TbBuild): string[] {
  const out = new Set<string>();
  for (const [id, item] of Object.entries(built.catalog?.items ?? {})) {
    const i = id.indexOf("__");
    if (i > 0 && item.type === "Product") out.add(id.slice(0, i));
  }
  return [...out];
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

/** Talabat fetch images themselves: relative paths become absolute, https only. */
function absoluteImage(url?: string | null): string | null {
  const u = String(url ?? "").trim();
  if (!u || u.startsWith("data:")) return null;
  if (/^https:\/\//i.test(u)) return u;
  if (u.startsWith("/")) return `${publicApiOrigin()}${u}`;
  return u; // kept so the transformer can name it in a warning
}
