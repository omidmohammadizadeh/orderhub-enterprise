import {
  Injectable,
  NotFoundException,
  ConflictException,
  BadRequestException,
  Logger,
  Inject,
  forwardRef,
} from "@nestjs/common";
import { InjectQueue } from "@nestjs/bull";
import type { Queue } from "bull";
import type { Prisma } from "@orderhub/database";
import { PrismaService } from "../../infrastructure/database/prisma.service";
import type { AuthenticatedUser } from "../auth/interfaces/jwt-payload.interface";
import { PluService, randomPlu } from "./plu.service";
import { MenuAssignmentsService } from "./menu-assignments.service";
import { MenuAvailabilityService } from "../inventory/menu-availability.service";
import { resolveNestedModifierGroups } from "./nested-modifier-groups";
import {
  isAutoMasterMember,
  withAutoMasterFlag,
} from "../integrations/hubrise/hubrise-auto-master.composer";
import {
  QUEUES,
  MENU_JOBS,
  normalizePricingVariants,
  brandChannelRef,
  CHANNEL_VARIANT_PRESETS,
  type PricingVariant,
} from "@orderhub/shared";
import type {
  CreateMenuDto,
  UpdateMenuDto,
  CreateMasterMenuDto,
  CreateCategoryDto,
  UpdateCategoryDto,
  CreateMenuItemDto,
  UpdateMenuItemDto,
  AddItemToCategoryDto,
  ReorderDto,
} from "./dto/menu.dto";

/**
 * A size's PLU, derived from its parent item's.
 *
 * Mirrors genSkuPlu in the product form (Base44 convention: PARENT-1,
 * PARENT-2 …). It matters when copying a size set onto other items: reusing
 * the source's PLUs would give every pizza the same codes, and HubRise, Uber
 * Eats and Deliveroo all key their catalogues on them.
 */
function skuPluFor(parentPlu: string | null | undefined, index: number): string {
  const base = (parentPlu ?? "").trim() || randomPlu("product");
  return `${base}-${index + 1}`;
}

const MENU_INCLUDE = {
  categories: {
    orderBy: { sortOrder: "asc" as const },
    include: {
      items: {
        orderBy: { sortOrder: "asc" as const },
        include: {
          item: {
            include: {
              modifierGroupLinks: {
                include: { group: { include: { options: { orderBy: { sortOrder: "asc" as const } } } } },
                orderBy: { sortOrder: "asc" as const },
              },
              variants: { orderBy: { sortOrder: "asc" as const } },
            },
          },
        },
      },
    },
  },
} satisfies Prisma.MenuInclude;

// Per-transaction caches for deep-copy (clone + master menu): dedupe items and
// modifier groups so a shared row is copied once, and track PLUs handed out in
// the uncommitted tx so generateUnique (committed-only) can't hand out a dupe.
type DeepCopyCaches = {
  itemBySrc: Map<string, string>;
  groupBySrc: Map<string, string>;
  usedPlus: Set<string>;
};

@Injectable()
export class MenusService {
  private readonly logger = new Logger(MenusService.name);

  constructor(
    private readonly prisma: PrismaService,
    @InjectQueue(QUEUES.MENU_SYNC) private readonly menuSyncQueue: Queue,
    private readonly plu: PluService,
    // Phase AW-14 — strip items snoozed for POS from the active-menu
    // response so the till never offers an out-of-stock product.
    @Inject(forwardRef(() => MenuAvailabilityService))
    private readonly menuAvailability: MenuAvailabilityService,
    // Phase BA — serving-assignment resolver (assignment-first resolution).
    private readonly menuAssignments: MenuAssignmentsService,
  ) {}

  // ── Menu CRUD ─────────────────────────────────────────────────────────────

  async findAllByBrand(brandId: string, tenantId: string) {
    await this.assertBrandAccess(brandId, tenantId);
    return this.prisma.menu.findMany({
      where: { brandId, deletedAt: null },
      include: {
        _count: { select: { categories: true, versions: true } },
        versions: { orderBy: { version: "desc" }, take: 1, select: { version: true, label: true, createdAt: true } },
      },
      orderBy: { createdAt: "desc" },
    });
  }

  /**
   * Phase AP — list menus that belong to a specific LOCATION only.
   *
   * Operators were seeing menus from sibling locations because the menu
   * list page filtered by brandId; in a multi-location franchise that
   * brand owns several locations and their menus all rolled up. The
   * Menu tab now scopes strictly to the location currently selected
   * in the location selector, so each location only sees its own menus.
   *
   * We include menus whose Menu.locationId matches the requested
   * location. Legacy brand-only menus (Menu.locationId null) are
   * deliberately NOT included — they belong to no location in the
   * Phase AP model. Operators with one such menu can migrate it via
   * the existing update endpoint (set locationId on the menu).
   */
  async findAllByLocation(locationId: string, tenantId: string) {
    const location = await this.prisma.location.findFirst({
      where: { id: locationId, brand: { tenantId } },
      select: { id: true },
    });
    if (!location) throw new NotFoundException("Location not found");
    return this.prisma.menu.findMany({
      // Phase BA — a menu belongs to this location's list when it's homed
      // here (legacy locationId) OR currently SERVING here via an
      // assignment row written by the publish flow.
      where: {
        deletedAt: null,
        OR: [
          { locationId },
          { assignments: { some: { locationId } } },
        ],
      },
      include: {
        _count: { select: { categories: true, versions: true } },
        versions: {
          orderBy: { version: "desc" },
          take: 1,
          select: { version: true, label: true, createdAt: true },
        },
        // Live-at badges + publish-modal seeding on the dashboard.
        assignments: {
          select: {
            locationId: true,
            channel: true,
            brandId: true,
            publishedAt: true,
          },
        },
      },
      orderBy: { createdAt: "desc" },
    });
  }

  // Phase AW-18 — operator picked "All locations" in the location
  // switcher. Return every menu they can see across every location
  // their tenant has, additionally restricted to the user's assigned
  // UserLocation set when present. Empty scope → tenant-wide (matches
  // brands/locations service behaviour).
  async findAllForTenant(tenantId: string, userId: string) {
    const userLocations = await (this.prisma as any).userLocation.findMany({
      where: { userId },
      select: { locationId: true },
    });
    const allowedLocationIds: string[] | null = userLocations.length
      ? userLocations.map((r: { locationId: string }) => r.locationId)
      : null;
    return this.prisma.menu.findMany({
      where: {
        deletedAt: null,
        brand: { tenantId },
        ...(allowedLocationIds && {
          OR: [
            { locationId: { in: allowedLocationIds } },
            // Phase BA — menus serving an allowed location via an
            // assignment row count too, wherever they're homed.
            { assignments: { some: { locationId: { in: allowedLocationIds } } } },
            // Brand-only menus (no location) stay visible to anyone
            // in the tenant — they're the franchise-wide library, not
            // a location-scoped publication.
            { locationId: null },
          ],
        }),
      },
      include: {
        _count: { select: { categories: true, versions: true } },
        versions: {
          orderBy: { version: "desc" },
          take: 1,
          select: { version: true, label: true, createdAt: true },
        },
        // Live-at badges + publish-modal seeding on the dashboard.
        // Menu.locationId is a plain scalar — the UI joins location
        // names client-side against the locations list it already has.
        assignments: {
          select: {
            locationId: true,
            channel: true,
            brandId: true,
            publishedAt: true,
          },
        },
      },
      orderBy: { createdAt: "desc" },
    });
  }

  async findOne(menuId: string, tenantId: string) {
    const menu = await this.prisma.menu.findFirst({
      where: { id: menuId, deletedAt: null, brand: { tenantId } },
      include: MENU_INCLUDE,
    });
    if (!menu) throw new NotFoundException("Menu not found");
    return menu;
  }

  async create(brandId: string, tenantId: string, dto: CreateMenuDto) {
    await this.assertBrandAccess(brandId, tenantId);
    return this.prisma.menu.create({
      data: {
        brandId,
        name: dto.name,
        description: dto.description,
        status: "DRAFT",
        // Phase AM — Deliverect-style create form ships these. All
        // optional on the schema; only sent when the operator filled
        // them in.
        ...(dto.menuType && { menuType: dto.menuType as any }),
        ...(dto.bannerImage !== undefined && { bannerImage: dto.bannerImage }),
        ...(dto.logoImage !== undefined && { logoImage: dto.logoImage }),
        ...(dto.heroImage !== undefined && { heroImage: dto.heroImage }),
        ...(dto.locationId && { locationId: dto.locationId }),
      },
    });
  }

  async update(
    menuId: string,
    tenantId: string,
    dto: UpdateMenuDto,
    userId?: string,
  ) {
    await this.assertMenuAccess(menuId, tenantId);
    // Phase AW — verify the destination brand belongs to the caller
    // before we let the publish picker re-home the menu. Without this
    // a stale brandId in the picker could move the menu under a sibling
    // tenant's brand.
    if (dto.brandId) await this.assertBrandAccess(dto.brandId, tenantId);
    // Same guard for the destination location — the publish picker can
    // re-home the menu onto a location, and that location must be ours.
    if (dto.locationId) await this.assertLocationAccess(dto.locationId, tenantId);

    // Phase BA — multi-location publish. When the modal sends locationIds
    // alongside publishedTo, the selected locations' serving assignments
    // are rewritten in the same transaction:
    //   • upsert one row per (location × channel) — the unique key
    //     (locationId, channel, brandId) makes this REPLACE whatever menu
    //     held the slot, without touching any OTHER location's rows;
    //   • delete THIS menu's rows at the selected locations for channels
    //     that were deselected — publish is authoritative for the picked
    //     locations only.
    // Menu.locationId (home location) is no longer re-written by publish;
    // legacy dto.locationId still lands for old clients.
    const locationIds = (dto as any).locationIds as string[] | undefined;
    if (locationIds !== undefined) {
      for (const id of locationIds) {
        await this.assertLocationAccess(id, tenantId);
      }
    }

    const menuRow = await this.prisma.menu.findUnique({
      where: { id: menuId },
      select: { brandId: true, brand: { select: { tenantId: true } } },
    });
    const assignmentBrandId = dto.brandId ?? menuRow?.brandId ?? null;

    const menuUpdate = this.prisma.menu.update({
      where: { id: menuId },
      data: {
        ...(dto.name && { name: dto.name }),
        ...(dto.description !== undefined && { description: dto.description }),
        ...(dto.status && { status: dto.status as any }),
        ...(dto.isActive !== undefined && { isActive: dto.isActive }),
        ...(dto.menuType && { menuType: dto.menuType as any }),
        ...(dto.bannerImage !== undefined && { bannerImage: dto.bannerImage }),
        ...(dto.logoImage !== undefined && { logoImage: dto.logoImage }),
        ...(dto.heroImage !== undefined && { heroImage: dto.heroImage }),
        ...(dto.locationId !== undefined && { locationId: dto.locationId }),
        ...(dto.brandId && { brandId: dto.brandId }),
        // Phase AM — publish target picker writes its selection here.
        // Stamping lastPublishedAt only when at least one target is on
        // means an "unpublish-all" leaves the previous stamp intact for
        // audit trail purposes. Phase BA: publishedTo demotes to the
        // "last publish selection" audit field — assignments are the
        // serving truth.
        ...(dto.publishedTo !== undefined && {
          publishedTo: dto.publishedTo,
          ...(dto.publishedTo.length > 0 && {
            lastPublishedAt: new Date(),
          }),
        }),
        // Phase AZ — pricing variants. Normalise + dedupe before storing
        // so a malformed client payload can't corrupt the publish path.
        ...((dto as any).pricingVariants !== undefined && {
          pricingVariants: normalizePricingVariants(
            (dto as any).pricingVariants,
          ) as any,
        }),
      },
    });

    if (
      locationIds === undefined ||
      dto.publishedTo === undefined ||
      !assignmentBrandId
    ) {
      return menuUpdate;
    }

    const now = new Date();
    const channels = dto.publishedTo;
    // ADDITIVE publish (per operator request): upsert one serving assignment
    // per (location × channel) for the channels in THIS publish. The unique
    // key (locationId, channel, brandId) still makes the upsert REPLACE
    // whatever menu held that slot — so publishing a *different* menu to a
    // channel swaps it. What we deliberately DON'T do any more is delete this
    // menu's rows for channels not in the current publish: publishing a menu
    // to Online must not remove it from POS. Removing a menu from a specific
    // channel is now an explicit action (unpublishFromChannel), not a
    // side effect of publishing to a different channel.
    const [updated] = await this.prisma.$transaction([
      menuUpdate,
      ...locationIds.flatMap((locationId) =>
        channels.map((channel) =>
          (this.prisma as any).menuChannelAssignment.upsert({
            where: {
              locationId_channel_brandId: {
                locationId,
                channel,
                brandId: assignmentBrandId,
              },
            },
            create: {
              tenantId: menuRow?.brand?.tenantId ?? tenantId,
              menuId,
              locationId,
              brandId: assignmentBrandId,
              channel,
              publishedAt: now,
              createdBy: userId ?? null,
            },
            update: { menuId, publishedAt: now },
          }),
        ),
      ),
    ]);
    return updated;
  }

  /**
   * Explicitly remove a menu from a channel at a location (the additive
   * counterpart to publish — see the publish transaction above). Deletes only
   * that (menu, location, channel) serving assignment; other channels/menus
   * are untouched.
   */
  async unpublishFromChannel(
    menuId: string,
    tenantId: string,
    locationId: string,
    channel: string,
  ): Promise<{ removed: number }> {
    await this.assertMenuAccess(menuId, tenantId);
    await this.assertLocationAccess(locationId, tenantId);
    const res = await (this.prisma as any).menuChannelAssignment.deleteMany({
      where: { menuId, locationId, channel },
    });
    return { removed: res.count ?? 0 };
  }

  async publish(menuId: string, tenantId: string, userId?: string) {
    const menu = await this.assertMenuAccess(menuId, tenantId);

    // Snapshot for versioning
    const fullMenu = await this.findOne(menuId, tenantId);
    const lastVersion = await this.prisma.menuVersion.findFirst({
      where: { menuId },
      orderBy: { version: "desc" },
      select: { version: true },
    });

    await this.prisma.$transaction([
      this.prisma.menu.update({
        where: { id: menuId },
        data: { status: "PUBLISHED", isActive: true },
      }),
      this.prisma.menuVersion.create({
        data: {
          menuId,
          version: (lastVersion?.version ?? 0) + 1,
          snapshot: fullMenu as any,
          label: `Published ${new Date().toISOString().split("T")[0]}`,
          createdBy: userId ?? null,
        },
      }),
    ]);

    await this.menuSyncQueue.add(
      MENU_JOBS.PUSH_TO_PLATFORM,
      { menuId, brandId: menu.brandId, tenantId },
      {
        attempts: 3,
        backoff: { type: "exponential", delay: 5000 },
        jobId: `menu-push-${menuId}-${Date.now()}`,
      },
    );

    return this.prisma.menu.findUnique({ where: { id: menuId } });
  }

  async archive(menuId: string, tenantId: string) {
    await this.assertMenuAccess(menuId, tenantId);
    // Phase BA — an archived menu must stop serving: clear its assignments
    // so the slots free up for another menu (resolution would skip it via
    // isActive anyway; this keeps the table honest).
    const [updated] = await this.prisma.$transaction([
      this.prisma.menu.update({
        where: { id: menuId },
        data: { status: "ARCHIVED", isActive: false },
      }),
      (this.prisma as any).menuChannelAssignment.deleteMany({
        where: { menuId },
      }),
    ]);
    return updated;
  }

  async remove(menuId: string, tenantId: string) {
    await this.assertMenuAccess(menuId, tenantId);
    // Phase BA — same as archive: a deleted menu must release its slots.
    await this.prisma.$transaction([
      this.prisma.menu.update({
        where: { id: menuId },
        data: { deletedAt: new Date() },
      }),
      (this.prisma as any).menuChannelAssignment.deleteMany({
        where: { menuId },
      }),
    ]);
  }

  /**
   * Bulk-tag every item in a menu to a single brand. Replaces each item's brand
   * set with just [brandId] (so a previously-tagged brand is unticked) and sets
   * the primary brandId. Saves the operator opening every product to tick a box.
   */
  async tagAllItemsBrand(menuId: string, tenantId: string, brandId: string) {
    await this.findOne(menuId, tenantId); // 404s if the menu isn't in the tenant
    const brand = await this.prisma.brand.findFirst({
      where: { id: brandId, tenantId },
      select: { id: true },
    });
    if (!brand) throw new NotFoundException("Brand not found");

    const links = await this.prisma.menuItemOnCategory.findMany({
      where: { category: { menuId } },
      select: { itemId: true },
    });
    const itemIds = Array.from(new Set(links.map((l) => l.itemId)));

    // Re-home the MENU too, not only its products.
    //
    // An operator who taps "Tag brand" on a menu means "this menu is Smashing
    // Burger's". Tagging only the items left Menu.brandId pointing at whichever
    // brand happened to be selected in the dashboard when the menu was created
    // or imported — the HubRise import stamps it that way — so the menu still
    // showed the wrong brand everywhere the row's own brand is displayed, and
    // there was no other UI to correct it.
    await this.prisma.menu.update({ where: { id: menuId }, data: { brandId } });

    if (!itemIds.length) return { updated: 0, menuRebranded: true };

    await this.prisma.menuItem.updateMany({
      where: { id: { in: itemIds } },
      data: { brandId, brandIds: [brandId] },
    });
    return { updated: itemIds.length, menuRebranded: true };
  }

  async clone(
    menuId: string,
    tenantId: string,
    name: string,
    opts?: { targetLocationId?: string },
  ) {
    const source = await this.findOne(menuId, tenantId);

    // Cross-location clone: home the copy (and its items) to the target
    // location so it shows up under that location and belongs to it. Validate
    // the target belongs to this tenant.
    let targetLocationId: string | null = (source as any).locationId ?? null;
    if (opts?.targetLocationId) {
      const loc = await this.prisma.location.findFirst({
        where: { id: opts.targetLocationId, brand: { tenantId } },
        select: { id: true },
      });
      if (!loc) throw new NotFoundException("Target location not found");
      targetLocationId = opts.targetLocationId;
    }

    // DEEP clone — every MenuItem is duplicated so the copy is completely
    // independent of the source: deleting or editing an item in the clone
    // never affects the original menu (the old clone linked the SAME itemId,
    // so a delete hit both). PLUs (item + per-SKU) are cleared so the copy
    // carries no colliding codes — run "Generate missing PLUs" to assign
    // fresh ones. Modifier GROUPS stay shared (referenced by id); only the
    // item↔group link rows are re-created for the new items.
    // Seed existing PLUs BEFORE the transaction so deep-copy mints fresh ones
    // purely in memory (no per-PLU DB round-trip inside the tx).
    const usedPlus = new Set<string>();
    await this.seedUsedPlus(tenantId, usedPlus);

    return this.prisma.$transaction(
      async (tx) => {
      const cloned = await tx.menu.create({
        // Inherit the source's home location so the clone shows up on the
        // location-scoped menu page. Without this the clone was created
        // brand-only (locationId null) and never appeared in the list — the
        // clone "did nothing" from the operator's point of view even though
        // it succeeded. menuType carried over so the copy is a true duplicate.
        data: {
          brandId: source.brandId,
          locationId: targetLocationId,
          name,
          status: "DRAFT",
          ...((source as any).menuType && {
            menuType: (source as any).menuType,
          }),
        },
      });

      // Same item can appear under multiple categories — copy it once.
      const itemIdMap = new Map<string, string>();
      // Shared deep-copy caches: groups copied once, PLUs de-duped in-tx.
      const caches: DeepCopyCaches = {
        itemBySrc: itemIdMap,
        groupBySrc: new Map(),
        usedPlus,
      };
      // Collapse duplicate PRODUCTS. A master menu (combined from several source
      // menus) or a re-imported menu can hold multiple MenuItem rows for the
      // exact same product — cloning them 1:1 produced "4× 9 Chicken Strips Box"
      // in inventory + on HubRise. Key on brand+name+price so genuinely distinct
      // items (or the same name under different brands) are NOT merged.
      const identityMap = new Map<string, string>();
      // Guard against linking the same (merged) item to a category twice.
      const linkedInCat = new Set<string>();

      for (const cat of source.categories) {
        const newCat = await tx.menuCategory.create({
          data: {
            menuId: cloned.id,
            name: cat.name,
            description: (cat as any).description ?? null,
            sortOrder: cat.sortOrder,
          },
        });
        for (const link of cat.items) {
          const src = (link as any).item;
          let newItemId = itemIdMap.get(link.itemId);
          // Reuse an already-cloned copy of the SAME product (brand+name+price)
          // so duplicate source items collapse into one.
          if (!newItemId && src) {
            const identity = `${src.brandId ?? ""}|${(src.name ?? "").trim().toLowerCase()}`;
            const dupNewId = identityMap.get(identity);
            if (dupNewId) {
              newItemId = dupNewId;
              itemIdMap.set(link.itemId, dupNewId);
            }
          }
          if (!newItemId && src) {
            // Deep-copy: brand-new product + its own new modifier groups and
            // options (fresh PLUs), so editing the clone never touches the
            // source location's catalog.
            newItemId = await this.deepCopyItemTx(
              tx,
              src,
              tenantId,
              targetLocationId ?? null,
              caches,
            );
            identityMap.set(
              `${src.brandId ?? ""}|${(src.name ?? "").trim().toLowerCase()}`,
              newItemId,
            );
          }
          if (newItemId && !linkedInCat.has(`${newCat.id}|${newItemId}`)) {
            linkedInCat.add(`${newCat.id}|${newItemId}`);
            await tx.menuItemOnCategory.create({
              data: {
                categoryId: newCat.id,
                itemId: newItemId,
                sortOrder: link.sortOrder,
                priceOverride: link.priceOverride,
              },
            });
          }
        }
      }

      return cloned;
      },
      // Deep-copy writes many rows; the default 5s interactive-transaction
      // budget is not enough for large menus.
      { timeout: 120_000, maxWait: 20_000 },
    );
  }

  // ── Deep-copy helpers (clone + master menu) ──────────────────────────────
  //
  // A clone/master menu must be FULLY independent: new products, new modifier
  // groups, new modifier options, each with a fresh unique PLU. Editing the copy
  // must never touch the source location. These helpers do that inside the
  // caller's $transaction, sharing caches so a group/item used by several items
  // is copied exactly once per menu.

  /** Seed a used-PLU set with every PLU already in the tenant, ONCE, before a
   *  deep-copy transaction. Deep-copy then mints PLUs purely in memory (see
   *  freshPlu) — no per-PLU DB round-trip inside the transaction, which is what
   *  blew the 5s interactive-transaction budget on large master menus. */
  private async seedUsedPlus(
    tenantId: string,
    used: Set<string>,
  ): Promise<void> {
    const brands = await this.prisma.brand.findMany({
      where: { tenantId, deletedAt: null },
      select: { id: true },
    });
    const brandIds = brands.map((b) => b.id);
    const [items, groups, options] = await Promise.all([
      this.prisma.menuItem.findMany({
        where: { brandId: { in: brandIds }, plu: { not: null } },
        select: { plu: true },
      }),
      this.prisma.modifierGroup.findMany({
        where: { brandId: { in: brandIds }, plu: { not: null } },
        select: { plu: true },
      }),
      this.prisma.modifierOption.findMany({
        where: { group: { brandId: { in: brandIds } }, plu: { not: null } },
        select: { plu: true },
      }),
    ]);
    for (const r of items) if (r.plu) used.add(r.plu);
    for (const r of groups) if (r.plu) used.add(r.plu);
    for (const r of options) if (r.plu) used.add(r.plu);
  }

  /** Unique PLU generated purely in memory — checks only the (pre-seeded)
   *  `used` set, so it makes NO database call. Callers MUST seed `used` with
   *  the tenant's existing PLUs first (see seedUsedPlus). */
  private freshPlu(
    kind: "product" | "modifierGroup" | "modifier",
    used: Set<string>,
  ): string {
    for (let i = 0; i < 50; i++) {
      const p = randomPlu(kind);
      if (!used.has(p)) {
        used.add(p);
        return p;
      }
    }
    const p = `${randomPlu(kind)}-${used.size}`;
    used.add(p);
    return p;
  }

  /** Deep-copy one modifier group + its (primary-owned) options into brand-new
   *  rows with fresh PLUs. Cached by source group id so a group shared across
   *  items is copied once. Returns the new group id. */
  private async copyModifierGroupTx(
    tx: any,
    srcGroup: any,
    tenantId: string,
    targetLocationId: string | null,
    caches: DeepCopyCaches,
  ): Promise<string> {
    const cached = caches.groupBySrc.get(srcGroup.id);
    if (cached) return cached;
    const gPlu = this.freshPlu("modifierGroup", caches.usedPlus);
    const newGroup = await tx.modifierGroup.create({
      data: {
        brandId: srcGroup.brandId,
        locationId: targetLocationId ?? srcGroup.locationId ?? null,
        name: srcGroup.name,
        description: srcGroup.description ?? null,
        plu: gPlu,
        minSelections: srcGroup.minSelections ?? 0,
        maxSelections: srcGroup.maxSelections ?? null,
        isRequired: srcGroup.isRequired ?? false,
        sortOrder: srcGroup.sortOrder ?? 0,
        allowDuplicateSelections: srcGroup.allowDuplicateSelections ?? false,
        visibleToCustomers: srcGroup.visibleToCustomers ?? true,
        selectionType: srcGroup.selectionType,
        metadata: srcGroup.metadata ?? {},
      },
    });
    // Cached BEFORE the options are copied, so a nested group that points back
    // up its own branch resolves to the copy already in flight instead of
    // recursing forever.
    caches.groupBySrc.set(srcGroup.id, newGroup.id);

    // A group's `options` relation is the FK-PRIMARY set only. A modifier can
    // also belong through the modifierGroupIds[] array — that's what "Add
    // Existing" does, and what the importer does for every group after the
    // first when an option is shared between several ("shared from …" in the
    // editor). Copying only the relation produced a clone whose group came out
    // reading "No modifiers attached" while the original showed two.
    //
    // Same union mergeArrayAttachedOptions does on the read path, tenant-
    // scoped so a cross-brand attach within the tenant still comes along.
    const arrayAttached = await tx.modifierOption.findMany({
      where: {
        modifierGroupIds: { has: srcGroup.id },
        group: { brand: { tenantId } },
      },
      orderBy: { sortOrder: "asc" },
    });
    const ownIds = new Set((srcGroup.options ?? []).map((o: any) => o.id));
    const srcOptions = [
      ...(srcGroup.options ?? []),
      ...arrayAttached.filter((o: any) => !ownIds.has(o.id)),
    ];

    for (const opt of srcOptions) {
      const oPlu = this.freshPlu("modifier", caches.usedPlus);
      const newOption = await tx.modifierOption.create({
        data: {
          groupId: newGroup.id,
          modifierGroupIds: [], // fresh copy belongs to its new group only
          name: opt.name,
          description: opt.description ?? null,
          priceAdjustment: opt.priceAdjustment ?? 0,
          plu: oPlu,
          pricesBySize: opt.pricesBySize ?? {},
          skuPlus: {},
          platformPricingOverrides: opt.platformPricingOverrides ?? {},
          imageUrl: opt.imageUrl ?? null,
          allergens: opt.allergens ?? [],
          isDefault: opt.isDefault ?? false,
          isAvailable: opt.isAvailable ?? true,
          visibleToCustomers: opt.visibleToCustomers ?? true,
          sortOrder: opt.sortOrder ?? 0,
          deliveryTax: opt.deliveryTax ?? 0,
          takeawayTax: opt.takeawayTax ?? 0,
          eatInTax: opt.eatInTax ?? 0,
          metadata: opt.metadata ?? {},
        },
      });

      // Phase BN — the groups this option opens. A deep copy that skipped
      // these produced a clone whose "Make It a Meal" was selectable and
      // asked for nothing: the links pointed at the SOURCE menu's groups, or
      // at nothing at all. Copied recursively so the clone stays completely
      // independent, which is the whole point of the deep copy.
      const nestedLinks = await tx.modifierOptionNestedGroup.findMany({
        where: { optionId: opt.id },
        orderBy: { sortOrder: "asc" },
      });
      for (const link of nestedLinks) {
        const srcNested = await tx.modifierGroup.findFirst({
          where: { id: link.groupId, brand: { tenantId } },
          include: { options: { orderBy: { sortOrder: "asc" } } },
        });
        if (!srcNested) continue;
        const newNestedGroupId = await this.copyModifierGroupTx(
          tx,
          srcNested,
          tenantId,
          targetLocationId,
          caches,
        );
        await tx.modifierOptionNestedGroup.create({
          data: {
            optionId: newOption.id,
            groupId: newNestedGroupId,
            sortOrder: link.sortOrder,
          },
        });
      }
    }
    return newGroup.id;
  }

  /** Deep-copy one menu item into a brand-new independent product (fresh PLU,
   *  fresh SKUs cleared) with its own copied modifier groups. Returns new id. */
  private async deepCopyItemTx(
    tx: any,
    src: any,
    tenantId: string,
    targetLocationId: string | null,
    caches: DeepCopyCaches,
  ): Promise<string> {
    const cached = caches.itemBySrc.get(src.id);
    if (cached) return cached;
    const iPlu = this.freshPlu("product", caches.usedPlus);

    // A sized product routes its modifier groups through productSkus[], which
    // holds bare group ids with no FK. Copied verbatim, the clone's sizes
    // pointed at the SOURCE menu's groups — so editing the clone changed
    // nothing the clone actually served, and deleting the original emptied it.
    // Copy those groups too (deduped via the cache) and remap the ids.
    const srcSkus = Array.isArray(src.productSkus) ? src.productSkus : [];
    const skuGroupMap = new Map<string, string>();
    for (const gid of new Set(
      srcSkus.flatMap((sku: any) =>
        (sku?.modifierGroups ?? []).filter(
          (id: unknown): id is string => typeof id === "string" && !!id,
        ),
      ),
    )) {
      const srcGroup = await tx.modifierGroup.findFirst({
        where: { id: gid as string, brand: { tenantId } },
        include: { options: { orderBy: { sortOrder: "asc" } } },
      });
      if (!srcGroup) continue;
      skuGroupMap.set(
        gid as string,
        await this.copyModifierGroupTx(
          tx,
          srcGroup,
          tenantId,
          targetLocationId,
          caches,
        ),
      );
    }
    const skus = Array.isArray(src.productSkus)
      ? srcSkus.map((sku: any) => ({
          ...sku,
          plu: null,
          modifierGroups: (sku?.modifierGroups ?? []).map(
            (id: string) => skuGroupMap.get(id) ?? id,
          ),
        }))
      : (src.productSkus ?? []);
    const created = await tx.menuItem.create({
      data: {
        brandId: src.brandId,
        locationId: targetLocationId ?? src.locationId ?? null,
        name: src.name,
        description: src.description ?? null,
        basePrice: src.basePrice,
        imageUrl: src.imageUrl ?? null,
        sku: null,
        plu: iPlu,
        isAvailable: src.isAvailable,
        visibleToCustomers: src.visibleToCustomers,
        outOfStock: false,
        allergens: src.allergens ?? [],
        dietaryTags: src.dietaryTags ?? [],
        dietary: src.dietary ?? [],
        calories: src.calories ?? null,
        prepTime: src.prepTime ?? null,
        metadata: src.metadata ?? {},
        hasMultipleSkus: src.hasMultipleSkus,
        productSkus: skus,
        deliveryTax: src.deliveryTax,
        takeawayTax: src.takeawayTax,
        eatInTax: src.eatInTax,
        brandIds: src.brandIds ?? [],
        sortOrder: src.sortOrder,
        isInventoryTracked: src.isInventoryTracked,
        platformPricingOverrides: src.platformPricingOverrides ?? {},
      },
    });
    caches.itemBySrc.set(src.id, created.id);
    for (const link of src.modifierGroupLinks ?? []) {
      if (!link.group) continue;
      const newGroupId = await this.copyModifierGroupTx(
        tx,
        link.group,
        tenantId,
        targetLocationId,
        caches,
      );
      await tx.modifierGroupOnItem.create({
        data: {
          itemId: created.id,
          groupId: newGroupId,
          sortOrder: link.sortOrder ?? 0,
        },
      });
    }
    return created.id;
  }

  /**
   * Phase BC — Master Menu. HubRise only connects one menu per location, but
   * a kitchen can sell several brands. This merges the categories/items of
   * several existing menus at a location into one new menu — WITHOUT
   * duplicating any MenuItem/ModifierGroup row (same pattern as clone():
   * new MenuCategory rows that link to the SAME itemId). Because brand
   * association lives on the item itself (MenuItem.brandId), not derived
   * from which menu it's in, every item keeps its original brand no matter
   * how many source menus are merged. We also seed pricingVariants with a
   * brand×channel leaf per distinct brand found among the merged items, so
   * the HubRise publish path's per-brand `restrictions.variant_refs` (see
   * variantRefsForBrands) works immediately without manual setup.
   */
  async createMasterMenu(
    locationId: string,
    tenantId: string,
    dto: CreateMasterMenuDto,
  ) {
    const location = await this.assertLocationAccess(locationId, tenantId);
    const sourceMenuIds = Array.from(new Set(dto.sourceMenuIds ?? []));
    if (sourceMenuIds.length === 0) {
      throw new BadRequestException("Select at least one menu to combine.");
    }

    const sources = await this.prisma.menu.findMany({
      where: { id: { in: sourceMenuIds }, deletedAt: null, brand: { tenantId } },
      include: {
        brand: { select: { id: true, name: true } },
        categories: {
          orderBy: { sortOrder: "asc" },
          include: {
            items: {
              orderBy: { sortOrder: "asc" },
              include: {
                item: {
                  include: {
                    modifierGroupLinks: {
                      include: {
                        group: {
                          include: {
                            options: { orderBy: { sortOrder: "asc" } },
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    });
    if (sources.length !== sourceMenuIds.length) {
      throw new NotFoundException("One or more selected menus were not found.");
    }
    // Keep the requested order (findMany doesn't preserve `in` order) so
    // category numbering/collision suffixing is deterministic.
    const sourceById = new Map(sources.map((m) => [m.id, m]));
    const orderedSources = sourceMenuIds
      .map((id) => sourceById.get(id))
      .filter((m): m is (typeof sources)[number] => !!m);

    // Every distinct brand found on a merged item gets a pricing-variant
    // leaf per channel preset, matching the manual "Add brand" flow in
    // VariantsManagerModal — so the operator can publish per-brand prices
    // straight away instead of re-building variants from scratch.
    const brandIds = new Set<string>();
    for (const menu of orderedSources) {
      for (const cat of menu.categories) {
        for (const link of cat.items) {
          brandIds.add(link.item.brandId);
          for (const b of link.item.brandIds ?? []) brandIds.add(b);
        }
      }
    }
    const brandRows = brandIds.size
      ? await this.prisma.brand.findMany({
          where: { id: { in: Array.from(brandIds) }, tenantId },
          select: { id: true, name: true },
        })
      : [];
    const pricingVariants: PricingVariant[] = brandRows.flatMap((b) =>
      CHANNEL_VARIANT_PRESETS.map((preset) => ({
        ref: brandChannelRef(b.id, preset.channelKey),
        name: `${b.name} — ${preset.name}`,
        channelKey: preset.channelKey,
        brandId: b.id,
        brandName: b.name,
      })),
    );

    // Seed existing PLUs BEFORE the transaction so the deep-copy generates
    // fresh ones in memory — no per-PLU DB round-trip inside the tx (that is
    // what expired the 5s interactive-transaction budget on big master menus).
    const usedPlus = new Set<string>();
    await this.seedUsedPlus(tenantId, usedPlus);

    return this.prisma.$transaction(
      async (tx) => {
      const master = await tx.menu.create({
        data: {
          brandId: location.brandId,
          locationId,
          name: dto.name,
          description: dto.description,
          status: "DRAFT",
          pricingVariants: pricingVariants as any,
        },
      });

      // Disambiguate categories that collide by name ONLY across different
      // source brands (e.g. two brands both have "Sides") — keeps the
      // common single-brand-per-source-menu case clean (no needless
      // suffixing) while avoiding a confusing merged "Sides" that silently
      // mixes two brands' items under one heading.
      const nameOwner = new Map<string, string>();
      // Deep-copy caches shared across the whole master menu: each source
      // product/modifier group is copied into a NEW independent row exactly
      // once, with fresh PLUs — so the master menu never shares catalog rows
      // with the source locations.
      const caches: DeepCopyCaches = {
        itemBySrc: new Map(),
        groupBySrc: new Map(),
        usedPlus,
      };
      let sortOrder = 0;
      for (const menu of orderedSources) {
        const ownerKey = menu.brandId;
        for (const cat of menu.categories) {
          const collides =
            nameOwner.has(cat.name) && nameOwner.get(cat.name) !== ownerKey;
          if (!nameOwner.has(cat.name)) nameOwner.set(cat.name, ownerKey);
          const name = collides ? `${cat.name} (${menu.brand.name})` : cat.name;

          const newCat = await tx.menuCategory.create({
            data: {
              menuId: master.id,
              name,
              description: cat.description ?? null,
              imageUrl: cat.imageUrl ?? null,
              sortOrder: sortOrder++,
              isVisible: cat.isVisible,
              available: cat.available,
              visibleToCustomers: cat.visibleToCustomers,
            },
          });
          for (const link of cat.items) {
            const src = (link as any).item;
            if (!src) continue;
            // Deep-copy into a brand-new independent product (fresh PLUs, own
            // modifier groups) instead of sharing the source item row.
            const newItemId = await this.deepCopyItemTx(
              tx,
              src,
              tenantId,
              locationId,
              caches,
            );
            await tx.menuItemOnCategory.create({
              data: {
                categoryId: newCat.id,
                itemId: newItemId,
                sortOrder: link.sortOrder,
                priceOverride: link.priceOverride,
                isVisible: link.isVisible,
              },
            });
          }
        }
      }

      this.logger.log(
        `Master menu ${master.id} created at location=${locationId} from menus=[${sourceMenuIds.join(", ")}] (${brandRows.length} brands)`,
      );
      return master;
      },
      // Combining several menus deep-copies a lot of rows; the default 5s
      // interactive-transaction budget is not enough.
      { timeout: 120_000, maxWait: 20_000 },
    );
  }

  /**
   * Give this menu's products references of their own.
   *
   * A menu imported from HubRise carries HubRise's OWN product ids in
   * MenuItem.externalId, and those become the catalog refs on publish
   * (transformMenuToCatalog: `item.externalId ?? prod_<id>`). Import the same
   * HubRise catalog twice — once per brand, which is exactly how Clifton ended
   * up with "CLIFTON BURGERS" and "smashing burger" — and both menus' products
   * claim ids like `95m3488`. One catalog cannot hold two products under one
   * ref, so the composed publish refuses; see findDuplicateRefs.
   *
   * Detaching clears externalId and mints a fresh PLU, so the product's refs
   * become its own (`prod_<cuid>` and a new PLU) and stop colliding. Permanent
   * on purpose: the 86 → out-of-stock push keys on these same refs, so
   * disambiguating only at publish time would send 86s to refs HubRise doesn't
   * have.
   *
   * SHARED PRODUCTS ARE SKIPPED. An item also linked into another menu is that
   * menu's product too, and re-reffing it would silently change what the other
   * menu publishes. Those are reported back rather than touched.
   */
  async detachMenuFromImport(menuId: string, tenantId: string) {
    await this.assertMenuAccess(menuId, tenantId);

    const links = await this.prisma.menuItemOnCategory.findMany({
      where: { category: { menuId } },
      select: { itemId: true },
    });
    const itemIds = Array.from(new Set(links.map((l) => l.itemId)));
    if (!itemIds.length) {
      return { detached: 0, skippedShared: 0, alreadyIndependent: 0 };
    }

    // Anything linked into a DIFFERENT live menu belongs to that menu too.
    const elsewhere = await this.prisma.menuItemOnCategory.findMany({
      where: {
        itemId: { in: itemIds },
        category: { menuId: { not: menuId }, menu: { deletedAt: null } },
      },
      select: { itemId: true },
    });
    const shared = new Set(elsewhere.map((l) => l.itemId));
    const detachable = itemIds.filter((id) => !shared.has(id));

    const items = await this.prisma.menuItem.findMany({
      where: { id: { in: detachable } },
      select: {
        id: true,
        externalId: true,
        plu: true,
        hasMultipleSkus: true,
        productSkus: true,
      },
    });

    // Seed every PLU in the tenant once so the new ones are minted in memory —
    // no per-PLU round trip (the same reason createMasterMenu does it).
    const usedPlus = new Set<string>();
    await this.seedUsedPlus(tenantId, usedPlus);

    let detached = 0;
    let alreadyIndependent = 0;
    for (const item of items) {
      // Nothing imported and nothing to collide on — leave it exactly as it is
      // rather than churning a ref that is already the item's own.
      if (!item.externalId && !item.plu) {
        alreadyIndependent++;
        continue;
      }

      const skus = Array.isArray(item.productSkus)
        ? (item.productSkus as any[]).map((sku) => ({
            ...sku,
            plu: this.freshPlu("product", usedPlus),
          }))
        : item.productSkus;

      await this.prisma.menuItem.update({
        where: { id: item.id },
        data: {
          externalId: null,
          plu: this.freshPlu("product", usedPlus),
          ...(Array.isArray(item.productSkus) ? { productSkus: skus as any } : {}),
        },
      });
      detached++;
    }

    this.logger.log(
      `Detached menu ${menuId} from its import: ${detached} products re-reffed, ` +
        `${shared.size} shared with another menu left alone, ` +
        `${alreadyIndependent} already independent`,
    );
    return { detached, skippedShared: shared.size, alreadyIndependent };
  }

  // ── HubRise composed catalog membership ────────────────────────────────────
  //
  // HubRise allows ONE catalog per location, so several brands trading out of
  // one kitchen share it. Rather than hand-building and maintaining a merged
  // Master Menu, the operator names the menus that make up that catalog here;
  // publishing any of them then composes all of them (see
  // hubrise-auto-master.composer.ts). Membership is what makes the publish
  // payload complete — sending one brand alone would wipe the others.

  /** The location's menus, flagged with whether they're in the composed
   *  HubRise catalog, plus their product count so the operator can see that a
   *  menu is empty BEFORE the publish guard refuses it. */
  async listHubRiseCatalogMenus(locationId: string, tenantId: string) {
    await this.assertLocationAccess(locationId, tenantId);
    const menus = await this.prisma.menu.findMany({
      where: {
        deletedAt: null,
        brand: { tenantId },
        OR: [{ locationId }, { assignments: { some: { locationId } } }],
      },
      select: {
        id: true,
        name: true,
        brandId: true,
        metadata: true,
        lastPublishedAt: true,
        brand: { select: { name: true } },
      },
      orderBy: { createdAt: "asc" },
    });
    const counts = await Promise.all(
      menus.map((m) =>
        this.prisma.menuItemOnCategory.count({
          where: { category: { menuId: m.id } },
        }),
      ),
    );
    return menus.map((m, i) => ({
      id: m.id,
      name: m.name,
      brandId: m.brandId,
      brandName: m.brand?.name ?? null,
      lastPublishedAt: m.lastPublishedAt,
      productCount: counts[i],
      inHubRiseCatalog: isAutoMasterMember(m),
    }));
  }

  /** Replace the set of menus that make up this location's HubRise catalog.
   *  Menus not listed are removed from it; an empty list turns the composed
   *  catalog off entirely and every publish reverts to the single-menu path. */
  async setHubRiseCatalogMenus(
    locationId: string,
    tenantId: string,
    menuIds: string[],
  ) {
    await this.assertLocationAccess(locationId, tenantId);
    const wanted = new Set(menuIds ?? []);
    const menus = await this.prisma.menu.findMany({
      where: {
        deletedAt: null,
        brand: { tenantId },
        OR: [{ locationId }, { assignments: { some: { locationId } } }],
      },
      select: { id: true, metadata: true },
    });
    const known = new Set(menus.map((m) => m.id));
    for (const id of wanted) {
      if (!known.has(id)) {
        throw new BadRequestException(
          "One of the selected menus does not belong to this location.",
        );
      }
    }

    // Read-modify-write per row: metadata is a shared JSON blob and we must
    // not clobber keys other features put there.
    const changed = menus.filter(
      (m) => isAutoMasterMember(m) !== wanted.has(m.id),
    );
    if (changed.length) {
      await this.prisma.$transaction(
        changed.map((m) =>
          this.prisma.menu.update({
            where: { id: m.id },
            data: {
              metadata: withAutoMasterFlag(
                m.metadata,
                wanted.has(m.id),
              ) as any,
            },
          }),
        ),
      );
    }
    this.logger.log(
      `HubRise composed catalog at location=${locationId} now holds ${wanted.size} menus [${[...wanted].join(", ")}]`,
    );
    return this.listHubRiseCatalogMenus(locationId, tenantId);
  }

  // ── Menu Versioning ────────────────────────────────────────────────────────

  async getVersions(menuId: string, tenantId: string) {
    await this.assertMenuAccess(menuId, tenantId);
    return this.prisma.menuVersion.findMany({
      where: { menuId },
      orderBy: { version: "desc" },
      select: {
        id: true, version: true, label: true, createdBy: true, createdAt: true,
      },
    });
  }

  async rollback(menuId: string, versionId: string, tenantId: string) {
    await this.assertMenuAccess(menuId, tenantId);

    const version = await this.prisma.menuVersion.findFirst({
      where: { id: versionId, menuId },
    });
    if (!version) throw new NotFoundException("Version not found");

    // Restore: delete all current categories, recreate from snapshot
    const snapshot = version.snapshot as any;

    await this.prisma.$transaction(async (tx) => {
      await tx.menuCategory.deleteMany({ where: { menuId } });

      for (const cat of snapshot.categories ?? []) {
        const newCat = await tx.menuCategory.create({
          data: {
            menuId,
            name: cat.name,
            description: cat.description ?? null,
            sortOrder: cat.sortOrder,
          },
        });
        for (const link of cat.items ?? []) {
          const item = link.item;
          // Ensure item still exists
          const exists = await tx.menuItem.findUnique({ where: { id: item.id } });
          if (exists) {
            await tx.menuItemOnCategory.create({
              data: {
                categoryId: newCat.id,
                itemId: item.id,
                sortOrder: link.sortOrder,
                priceOverride: link.priceOverride,
              },
            }).catch(() => {});  // ignore if already linked
          }
        }
      }

      await tx.menu.update({
        where: { id: menuId },
        data: { status: "DRAFT" },
      });
    });

    this.logger.log(`Menu ${menuId} rolled back to version ${version.version}`);
    return this.findOne(menuId, tenantId);
  }

  // ── Category CRUD ─────────────────────────────────────────────────────────

  async createCategory(menuId: string, tenantId: string, dto: CreateCategoryDto) {
    await this.assertMenuAccess(menuId, tenantId);
    const maxOrder = await this.prisma.menuCategory.aggregate({
      where: { menuId },
      _max: { sortOrder: true },
    });
    return this.prisma.menuCategory.create({
      data: {
        menuId,
        name: dto.name,
        description: (dto as any).description ?? null,
        sortOrder: (maxOrder._max.sortOrder ?? -1) + 1,
      },
    });
  }

  async updateCategory(categoryId: string, tenantId: string, dto: UpdateCategoryDto) {
    await this.assertCategoryAccess(categoryId, tenantId);
    return this.prisma.menuCategory.update({
      where: { id: categoryId },
      data: {
        ...(dto.name && { name: dto.name }),
        ...((dto as any).description !== undefined && { description: (dto as any).description }),
        ...(dto.sortOrder !== undefined && { sortOrder: dto.sortOrder }),
        ...((dto as any).isActive !== undefined && { isVisible: (dto as any).isActive }),
      },
    });
  }

  async removeCategory(categoryId: string, tenantId: string) {
    await this.assertCategoryAccess(categoryId, tenantId);
    await this.prisma.menuCategory.delete({ where: { id: categoryId } });
  }

  async reorderCategories(menuId: string, tenantId: string, dto: ReorderDto) {
    await this.assertMenuAccess(menuId, tenantId);
    // ReorderDto carries `items: [{id, sortOrder}]` — earlier code read
    // `dto.order` which doesn't exist on the DTO, so every drag-drop
    // request silently no-op'd. The categories list looked like it had
    // shuffled in the UI but the next page-load reset to the old order.
    const items =
      (dto as any).items ?? (dto as any).order ?? [];
    if (items.length === 0) return;
    await this.prisma.$transaction(
      items.map(
        ({ id, sortOrder }: { id: string; sortOrder: number }) =>
          this.prisma.menuCategory.update({
            where: { id },
            data: { sortOrder },
          }),
      ),
    );
  }

  // ── MenuItem CRUD ─────────────────────────────────────────────────────────

  async findItemsByBrand(brandId: string, user: AuthenticatedUser) {
    await this.assertBrandAccess(brandId, user.tenantId);
    // Only surface the brand's library to users who can access this brand.
    const scope = await this.resolveCatalogScope(user);
    if (scope.brandIds !== null && !scope.brandIds.includes(brandId)) return [];
    return this.prisma.menuItem.findMany({
      where: {
        brandId,
        // Non-admins see only items stamped to their accessible locations,
        // plus brand-only (unassigned) library items — never another
        // location's products.
        ...(scope.locationIds !== null && {
          OR: [
            { locationId: { in: scope.locationIds } },
            { locationId: null },
          ],
        }),
      },
      include: {
        modifierGroupLinks: {
          include: { group: { include: { options: true } } },
        },
        variants: { orderBy: { sortOrder: "asc" } },
      },
      orderBy: { name: "asc" },
    });
  }

  // Phase AW-12 — single-item read. Tenant-scoped by joining MenuItem
  // → Brand to verify the brand belongs to the caller's tenant. Doing
  // the assert via assertBrandAccess after fetching the item id keeps
  // the access pattern consistent with the rest of the service.
  async findItemById(itemId: string, tenantId: string) {
    const item = await this.prisma.menuItem.findUnique({
      where: { id: itemId },
      include: {
        modifierGroupLinks: {
          include: { group: { include: { options: true } } },
        },
        variants: { orderBy: { sortOrder: "asc" } },
      },
    });
    if (!item) throw new NotFoundException(`Item ${itemId} not found`);
    await this.assertBrandAccess(item.brandId, tenantId);

    // A sized product's groups hang off the SKU as bare ids in a JSON column,
    // reachable from no include at any depth. The editor used to resolve them
    // against the LOCATION's group list, which drops every id that list
    // doesn't have — an imported menu whose groups sit on another brand of the
    // same tenant rendered as "No groups attached to this size yet", which is
    // a statement about the lookup, not about the product.
    const skuGroupIds = new Set<string>();
    const skus = (item as any).productSkus;
    if (Array.isArray(skus)) {
      for (const sku of skus) {
        for (const gid of sku?.modifierGroups ?? []) {
          if (typeof gid === "string" && gid) skuGroupIds.add(gid);
        }
      }
    }
    (item as any).skuModifierGroups = await this.loadGroupsByIds(
      skuGroupIds,
      tenantId,
    );
    return item;
  }

  /**
   * Phase AP — list catalog items scoped strictly to a location.
   *
   * Operators reported sibling locations seeing each other's products
   * because the Products tab was filtering by brandId. This mirrors
   * the Menu tab change: each shop only sees its own catalog. Items
   * with locationId=null are intentionally NOT included — those are
   * legacy brand-only rows the operator can re-assign from the UI.
   */
  async findItemsByLocation(locationId: string, user: AuthenticatedUser) {
    await this.assertLocationAccess(locationId, user.tenantId);
    // Never trust the client's locationId — a user may only see products for
    // locations they're assigned to.
    const scope = await this.resolveCatalogScope(user);
    if (scope.locationIds !== null && !scope.locationIds.includes(locationId))
      return [];
    return this.prisma.menuItem.findMany({
      where: { locationId },
      include: {
        modifierGroupLinks: {
          include: { group: { include: { options: true } } },
        },
        variants: { orderBy: { sortOrder: "asc" } },
      },
      orderBy: { name: "asc" },
    });
  }

  async createItem(brandId: string, tenantId: string, dto: CreateMenuItemDto) {
    await this.assertBrandAccess(brandId, tenantId);
    // Phase AK: auto-generate PLU if the caller didn't supply one. This
    // mirrors Base44's `prod_${Date.now()}` default but uses our
    // collision-safe generator. Operator can override via dto.plu.
    const explicitPlu = ((dto as any).plu as string | undefined)?.trim();
    const plu = explicitPlu || (await this.plu.generateUnique("product", tenantId));

    return this.prisma.menuItem.create({
      data: {
        brandId,
        // Phase AP — stamp the product onto a specific location when the
        // caller (Products tab) provides one. Without it the row stays
        // brand-only and shows up nowhere on the new location-scoped UI.
        ...((dto as any).locationId && { locationId: (dto as any).locationId }),
        name: dto.name,
        description: dto.description,
        basePrice: dto.basePrice,
        imageUrl: dto.imageUrl,
        sku: dto.sku,
        plu,
        calories: dto.calories,
        allergens: dto.allergens ?? [],
        dietaryTags: (dto as any).dietaryTags ?? [],
        prepTime: (dto as any).prepTime ?? null,
        isInventoryTracked: (dto as any).isInventoryTracked ?? false,
        inventoryCount: (dto as any).inventoryCount ?? null,
        platformPricingOverrides: (dto as any).platformPricingOverrides ?? {},
        // Phase AK fields — all optional, sensible defaults from schema:
        visibleToCustomers: (dto as any).visibleToCustomers ?? true,
        outOfStock: (dto as any).outOfStock ?? false,
        hasMultipleSkus: (dto as any).hasMultipleSkus ?? false,
        productSkus: ((dto as any).productSkus ?? []) as any,
        deliveryTax: (dto as any).deliveryTax ?? 0,
        takeawayTax: (dto as any).takeawayTax ?? 0,
        eatInTax: (dto as any).eatInTax ?? 0,
        dietary: ((dto as any).dietary ?? []) as any,
        menuIds: ((dto as any).menuIds ?? []) as any,
        brandIds: ((dto as any).brandIds ?? []) as any,
      },
      include: {
        variants: true,
        modifierGroupLinks: { include: { group: { include: { options: true } } } },
      },
    });
  }

  async updateItem(itemId: string, tenantId: string, dto: UpdateMenuItemDto) {
    await this.assertItemAccess(itemId, tenantId);
    return this.prisma.menuItem.update({
      where: { id: itemId },
      data: {
        ...(dto.name && { name: dto.name }),
        ...(dto.description !== undefined && { description: dto.description }),
        ...(dto.basePrice !== undefined && { basePrice: dto.basePrice }),
        ...(dto.imageUrl !== undefined && { imageUrl: dto.imageUrl }),
        ...(dto.sku !== undefined && { sku: dto.sku }),
        ...(dto.calories !== undefined && { calories: dto.calories }),
        ...(dto.allergens !== undefined && { allergens: dto.allergens }),
        ...(dto.isAvailable !== undefined && { isAvailable: dto.isAvailable }),
        // Phase AL — Base44 catalog fields. All optional; whitelisted on
        // the DTO so the global ValidationPipe lets them through.
        ...(dto.plu !== undefined && { plu: dto.plu }),
        ...(dto.outOfStock !== undefined && { outOfStock: dto.outOfStock }),
        ...(dto.visibleToCustomers !== undefined && {
          visibleToCustomers: dto.visibleToCustomers,
        }),
        ...(dto.hasMultipleSkus !== undefined && {
          hasMultipleSkus: dto.hasMultipleSkus,
        }),
        ...(dto.productSkus !== undefined && {
          productSkus: dto.productSkus as any,
        }),
        ...(dto.deliveryTax !== undefined && { deliveryTax: dto.deliveryTax }),
        ...(dto.takeawayTax !== undefined && { takeawayTax: dto.takeawayTax }),
        ...(dto.eatInTax !== undefined && { eatInTax: dto.eatInTax }),
        ...(dto.menuIds !== undefined && { menuIds: dto.menuIds }),
        ...(dto.brandIds !== undefined && { brandIds: dto.brandIds }),
        ...(dto.dietaryTags !== undefined && { dietaryTags: dto.dietaryTags }),
        ...((dto as any).prepTime !== undefined && { prepTime: (dto as any).prepTime }),
        ...((dto as any).isInventoryTracked !== undefined && { isInventoryTracked: (dto as any).isInventoryTracked }),
        ...((dto as any).inventoryCount !== undefined && { inventoryCount: (dto as any).inventoryCount }),
        ...(dto.platformPricingOverrides !== undefined && {
          platformPricingOverrides: dto.platformPricingOverrides,
        }),
      },
      include: {
        variants: true,
        modifierGroupLinks: { include: { group: { include: { options: true } } } },
      },
    });
  }

  async toggleAvailability(itemId: string, tenantId: string) {
    const item = await this.assertItemAccess(itemId, tenantId);
    return this.prisma.menuItem.update({
      where: { id: itemId },
      data: { isAvailable: !item.isAvailable },
    });
  }

  async removeItem(itemId: string, tenantId: string) {
    await this.assertItemAccess(itemId, tenantId);
    await this.prisma.menuItem.delete({ where: { id: itemId } });
  }

  // ── Bulk Operations ────────────────────────────────────────────────────────

  /**
   * Copy one item's modifier groups and/or its SKU set onto other items.
   *
   * Building a "Crusts" group and then re-attaching it by hand to nineteen
   * pizzas is the single most tedious thing in the menu editor, and it's where
   * menus drift out of step with each other.
   *
   * Modifier groups are brand-level rows joined through ModifierGroupOnItem,
   * so applying one is a LINK, not a copy — every item ends up pointing at the
   * same group, and editing its options later updates all of them at once.
   * That is the behaviour an operator expects from "use the same group".
   *
   * SKUs are the opposite: they live in MenuItem.productSkus as JSON, so they
   * genuinely are copied. PLUs are regenerated from each target's own PLU —
   * copying "PIZZA-10" onto nineteen items would give nineteen products the
   * same code, and marketplace catalogues key on it.
   */
  async applyItemConfigToItems(
    sourceItemId: string,
    tenantId: string,
    dto: {
      targetItemIds: string[];
      modifierGroupIds?: string[];
      includeSkus?: boolean;
    },
  ) {
    const source = await this.assertItemAccess(sourceItemId, tenantId);

    const targetIds = [...new Set(dto.targetItemIds ?? [])].filter(
      (id) => id && id !== sourceItemId,
    );
    if (targetIds.length === 0) {
      throw new BadRequestException("Select at least one other item");
    }

    // Same tenant check as the other bulk operations: MenuItem carries brandId
    // but has no Prisma relation to Brand, so verify through the brand list.
    const brands = await this.prisma.brand.findMany({
      where: { tenantId },
      select: { id: true },
    });
    const brandIds = brands.map((b) => b.id);
    const targets = await this.prisma.menuItem.findMany({
      where: { id: { in: targetIds }, brandId: { in: brandIds } },
      select: { id: true, plu: true },
    });
    if (targets.length !== targetIds.length) {
      throw new BadRequestException("Some items not found or not accessible");
    }

    const groupIds = [...new Set(dto.modifierGroupIds ?? [])];
    // Every group must belong to this tenant. Without this a caller could
    // staple another operator's modifier group onto their own menu.
    for (const groupId of groupIds) {
      await this.assertModifierGroupAccess(groupId, tenantId);
    }

    let linksCreated = 0;
    if (groupIds.length) {
      // skipDuplicates rather than create-and-catch: inside a transaction a
      // Postgres unique violation aborts the WHOLE transaction (25P02), so
      // re-applying a group an item already has would take the rest down
      // with it.
      const res = await this.prisma.modifierGroupOnItem.createMany({
        data: targets.flatMap((t) =>
          groupIds.map((groupId) => ({ itemId: t.id, groupId })),
        ),
        skipDuplicates: true,
      });
      linksCreated = res.count;
    }

    let skusApplied = 0;
    if (dto.includeSkus) {
      const sourceSkus = Array.isArray(source.productSkus)
        ? (source.productSkus as any[])
        : [];
      if (sourceSkus.length === 0) {
        throw new BadRequestException(
          "This item has no sizes to apply — add at least one first",
        );
      }
      // One update per target: each gets its own PLUs, so a single updateMany
      // can't do it.
      for (const target of targets) {
        const skus = sourceSkus.map((sku, i) => ({
          ...sku,
          plu: skuPluFor(target.plu, i),
        }));
        await this.prisma.menuItem.update({
          where: { id: target.id },
          data: { hasMultipleSkus: true, productSkus: skus as any },
        });
        skusApplied++;
      }
    }

    return {
      itemsUpdated: targets.length,
      modifierGroupLinksCreated: linksCreated,
      skusApplied,
    };
  }

  async bulkToggleAvailability(itemIds: string[], tenantId: string, isAvailable: boolean) {
    // Validate all items belong to tenant — MenuItem has brandId but no Prisma Brand relation
    const tenantBrands = await this.prisma.brand.findMany({ where: { tenantId }, select: { id: true } });
    const brandIds = tenantBrands.map((b) => b.id);
    const items = await this.prisma.menuItem.findMany({
      where: { id: { in: itemIds }, brandId: { in: brandIds } },
      select: { id: true },
    });
    if (items.length !== itemIds.length) {
      throw new BadRequestException("Some items not found or not accessible");
    }
    return this.prisma.menuItem.updateMany({
      where: { id: { in: itemIds } },
      data: { isAvailable },
    });
  }

  async bulkUpdatePrice(
    itemIds: string[],
    tenantId: string,
    adjustment: { type: "fixed" | "percentage"; value: number },
  ) {
    const tenantBrands2 = await this.prisma.brand.findMany({ where: { tenantId }, select: { id: true } });
    const brandIds2 = tenantBrands2.map((b) => b.id);
    const items = await this.prisma.menuItem.findMany({
      where: { id: { in: itemIds }, brandId: { in: brandIds2 } },
    });
    if (items.length !== itemIds.length) {
      throw new BadRequestException("Some items not found");
    }

    await this.prisma.$transaction(
      items.map((item) => {
        const currentPrice = Number(item.basePrice);
        const newPrice =
          adjustment.type === "fixed"
            ? currentPrice + adjustment.value
            : currentPrice * (1 + adjustment.value / 100);
        return this.prisma.menuItem.update({
          where: { id: item.id },
          data: { basePrice: Math.max(0, Math.round(newPrice * 100) / 100) },
        });
      }),
    );

    return { updated: items.length };
  }

  // ── Item Variants ──────────────────────────────────────────────────────────

  async createVariant(
    itemId: string,
    tenantId: string,
    dto: { name: string; price: number; sku?: string; sortOrder?: number },
  ) {
    await this.assertItemAccess(itemId, tenantId);
    return this.prisma.menuItemVariant.create({
      data: {
        itemId,
        name: dto.name,
        price: dto.price,
        sku: dto.sku ?? null,
        sortOrder: dto.sortOrder ?? 0,
      },
    });
  }

  async updateVariant(
    variantId: string,
    tenantId: string,
    dto: { name?: string; price?: number; sku?: string; sortOrder?: number; isAvailable?: boolean },
  ) {
    // MenuItem has no Brand relation; verify item ownership via brandId
    const variant = await this.prisma.menuItemVariant.findFirst({
      where: { id: variantId },
      include: { item: { select: { brandId: true } } },
    });
    if (!variant) throw new NotFoundException("Variant not found");
    const itemBrand = await this.prisma.brand.findFirst({ where: { id: variant.item.brandId, tenantId } });
    if (!itemBrand) throw new NotFoundException("Variant not found");
    return this.prisma.menuItemVariant.update({
      where: { id: variantId },
      data: {
        ...(dto.name && { name: dto.name }),
        ...(dto.price !== undefined && { price: dto.price }),
        ...(dto.sku !== undefined && { sku: dto.sku }),
        ...(dto.sortOrder !== undefined && { sortOrder: dto.sortOrder }),
        ...(dto.isAvailable !== undefined && { isAvailable: dto.isAvailable }),
      },
    });
  }

  async removeVariant(variantId: string, tenantId: string) {
    const variantToDelete = await this.prisma.menuItemVariant.findFirst({
      where: { id: variantId },
      include: { item: { select: { brandId: true } } },
    });
    if (!variantToDelete) throw new NotFoundException("Variant not found");
    const variantBrand = await this.prisma.brand.findFirst({ where: { id: variantToDelete.item.brandId, tenantId } });
    if (!variantBrand) throw new NotFoundException("Variant not found");
    await this.prisma.menuItemVariant.delete({ where: { id: variantId } });
  }

  // ── Modifier Groups ────────────────────────────────────────────────────────

  /**
   * Phase AP — list modifier groups for a location.
   * Same rationale as findItemsByLocation.
   *
   * Brand-level groups (locationId null) are included alongside the
   * location's own. They belong to every site by definition, so they are
   * never "another location's group" — and excluding them made real groups
   * vanish: until the location stamp was threaded through the product
   * editor, every group created via its "Create New" button was saved with
   * no location at all. Those rows are only reachable if null is admitted
   * here.
   */
  async findModifierGroupsByLocation(locationId: string, user: AuthenticatedUser) {
    // Doubles as the brand lookup below — a Location belongs to exactly one.
    const location = await this.assertLocationAccess(locationId, user.tenantId);
    // Never trust the client's locationId — a non-admin only sees modifier
    // groups for locations they're assigned to (mirrors findItemsByLocation).
    const scope = await this.resolveCatalogScope(user);
    if (scope.locationIds !== null && !scope.locationIds.includes(locationId))
      return [];
    const groups = await this.prisma.modifierGroup.findMany({
      where: {
        OR: [
          { locationId },
          // Brand-level rows, scoped to this location's own brand so a
          // tenant running several brands doesn't see all of them.
          { locationId: null, brandId: location.brandId },
        ],
      },
      include: {
        options: { orderBy: { sortOrder: "asc" } },
        _count: { select: { itemLinks: true } },
      },
      orderBy: { name: "asc" },
    });
    const merged = await this.mergeArrayAttachedOptions(groups, user.tenantId);
    return this.attachNestedGroups(merged, user.tenantId);
  }

  /**
   * Fold modifiers attached via the modifierGroupIds[] many-to-many array into
   * each group's `options` (the FK-relation include only returns primary-owned
   * ones). Without this the standalone modifier-group page shows "0 modifiers"
   * for a group whose modifiers were all added via "Add Existing". Tenant-scoped
   * so a cross-brand attach (same tenant) is still counted.
   */
  private async mergeArrayAttachedOptions<
    T extends { id: string; options: { id: string }[] },
  >(groups: T[], tenantId: string): Promise<T[]> {
    if (groups.length === 0) return groups;
    const groupIds = groups.map((g) => g.id);
    const arrayMatched = await this.prisma.modifierOption.findMany({
      where: {
        group: { brand: { tenantId } },
        modifierGroupIds: { hasSome: groupIds },
      },
      orderBy: { sortOrder: "asc" },
    });
    if (arrayMatched.length === 0) return groups;
    const extras = new Map<string, typeof arrayMatched>();
    for (const opt of arrayMatched) {
      for (const gId of opt.modifierGroupIds ?? []) {
        if (!groupIds.includes(gId)) continue;
        if (!extras.has(gId)) extras.set(gId, []);
        extras.get(gId)!.push(opt);
      }
    }
    return groups.map((g) => {
      const extra = extras.get(g.id) ?? [];
      if (extra.length === 0) return g;
      const seen = new Set(g.options.map((o) => o.id));
      return {
        ...g,
        options: [...g.options, ...extra.filter((o) => !seen.has(o.id))],
      } as T;
    });
  }

  // Phase AW-18.2 — single-row reads. Same brand-drift fix the items
  // path got in AW-12: the edit forms need to hydrate by id rather
  // than filter through a brand list (which may be empty when the
  // form's brandId disagrees with the row's actual brandId).
  async findModifierGroupById(groupId: string, tenantId: string) {
    const group = await this.prisma.modifierGroup.findUnique({
      where: { id: groupId },
      include: {
        options: { orderBy: { sortOrder: "asc" } },
        _count: { select: { itemLinks: true } },
      },
    });
    if (!group) throw new NotFoundException(`Modifier group ${groupId} not found`);
    await this.assertBrandAccess(group.brandId, tenantId);

    // Phase AL: `options` above only holds FK-primary modifiers. Also surface
    // modifiers attached via the modifierGroupIds[] many-to-many array —
    // otherwise "Add Existing" saves fine but the editor re-reads this endpoint
    // and shows the modifier as detached (it lived in the array, not the FK).
    // Scope by TENANT, not the option's owning brand — a modifier owned by a
    // group in another brand of the same tenant can be attached here (the
    // "Add Existing" picker allows it), and brand-scoping silently dropped
    // those, so cross-brand attaches looked unsaved.
    const arrayMatched = await this.prisma.modifierOption.findMany({
      where: {
        group: { brand: { tenantId } },
        modifierGroupIds: { has: groupId },
      },
      orderBy: { sortOrder: "asc" },
    });
    const merged =
      arrayMatched.length === 0
        ? group
        : {
            ...group,
            options: [
              ...group.options,
              ...arrayMatched.filter(
                (o) => !new Set(group.options.map((x) => x.id)).has(o.id),
              ),
            ],
          };

    // Phase BN — annotate each option with the groups it opens, so the group
    // editor can say "Make It a Meal → opens Choose Side, Choose Drink"
    // instead of showing it as an ordinary £3.99 option.
    await resolveNestedModifierGroups(this.prisma, [merged as any], { tenantId });
    return merged;
  }

  async findModifierOptionById(optionId: string, tenantId: string) {
    const option = await this.prisma.modifierOption.findUnique({
      where: { id: optionId },
      include: {
        group: { select: { brandId: true, name: true } },
        // Phase BN — the groups choosing this option opens ("Make It a Meal"
        // → a sides picker and a drinks picker). The editor can't show what
        // it can't see, so an imported meal deal looked identical to a plain
        // £3.99 option.
        nestedGroupLinks: {
          orderBy: { sortOrder: "asc" },
          include: { group: { select: { id: true, name: true } } },
        },
      },
    });
    if (!option) throw new NotFoundException(`Modifier ${optionId} not found`);
    await this.assertBrandAccess(option.group.brandId, tenantId);
    return {
      ...option,
      nestedGroupIds: option.nestedGroupLinks.map((l) => l.groupId),
      // Names travel WITH the option. The editor used to look them up in the
      // separately-fetched group list, which is brand-scoped — so a menu
      // imported under a different brand of the same tenant rendered every
      // follow-on group as "Unknown group" even though the link was right.
      nestedGroups: option.nestedGroupLinks.map((l) => ({
        id: l.groupId,
        name: l.group.name,
      })),
    };
  }

  /**
   * Replace the set of groups this option opens.
   *
   * Rewritten wholesale rather than diffed: the editor sends the list it
   * wants, and order in that list is the order the picker asks the questions.
   */
  async setNestedModifierGroups(
    optionId: string,
    tenantId: string,
    groupIds: string[],
  ) {
    const option = await this.prisma.modifierOption.findUnique({
      where: { id: optionId },
      select: { id: true, groupId: true, group: { select: { brandId: true } } },
    });
    if (!option) throw new NotFoundException(`Modifier ${optionId} not found`);
    await this.assertBrandAccess(option.group.brandId, tenantId);

    // Every target group must belong to this tenant — these ids come off the
    // request body, so they're not trusted. An option can't open the group it
    // already lives in either: that's a picker that reopens itself forever.
    const wanted = Array.from(new Set(groupIds)).filter(
      (id) => id !== option.groupId,
    );
    const allowed = wanted.length
      ? await this.prisma.modifierGroup.findMany({
          where: { id: { in: wanted }, brand: { tenantId } },
          select: { id: true },
        })
      : [];
    const allowedIds = new Set(allowed.map((g) => g.id));

    await this.prisma.$transaction(async (tx) => {
      await tx.modifierOptionNestedGroup.deleteMany({ where: { optionId } });
      let sortOrder = 0;
      for (const id of wanted) {
        if (!allowedIds.has(id)) continue;
        await tx.modifierOptionNestedGroup.create({
          data: { optionId, groupId: id, sortOrder: sortOrder++ },
        });
      }
    });

    return this.findModifierOptionById(optionId, tenantId);
  }

  async findModifierGroupsByBrand(brandId: string, user: AuthenticatedUser) {
    await this.assertBrandAccess(brandId, user.tenantId);
    // Only surface this brand's groups to users who can access the brand, and
    // only for locations they're assigned to (plus brand-only rows) — never
    // another location's modifier groups. Mirrors findItemsByBrand.
    const scope = await this.resolveCatalogScope(user);
    if (scope.brandIds !== null && !scope.brandIds.includes(brandId)) return [];
    const groups = await this.prisma.modifierGroup.findMany({
      where: {
        brandId,
        ...(scope.locationIds !== null && {
          OR: [{ locationId: { in: scope.locationIds } }, { locationId: null }],
        }),
      },
      include: {
        options: { orderBy: { sortOrder: "asc" } },
        _count: { select: { itemLinks: true } },
      },
      orderBy: { name: "asc" },
    });

    // Phase AL: also surface modifiers attached via the modifierGroupIds[]
    // many-to-many array, not just the FK-primary ones.
    //
    // This used to be a private copy of mergeArrayAttachedOptions that scoped
    // the lookup to `group: { brandId }` — the modifier's OWN group had to
    // belong to this brand. "Add Existing" lets you attach a modifier owned by
    // another brand of the same tenant, and those were dropped, so a group
    // listed here showed fewer modifiers than the very same group opened in
    // the editor (findModifierGroupById is tenant-scoped and always was).
    const merged = await this.mergeArrayAttachedOptions(groups, user.tenantId);
    return this.attachNestedGroups(merged, user.tenantId);
  }

  /**
   * Phase BN — annotate each option with the groups it opens when chosen, and
   * append any of those groups the caller's own query didn't already return.
   *
   * The pickers index this list by id, so a nested group that's missing from
   * it renders as a dead step: the option is selectable and asks for nothing.
   * That happens whenever a nested group belongs to a sibling brand of the
   * same tenant, which a brand-scoped list can't see.
   */
  private async attachNestedGroups<T extends { id: string; options: any[] }>(
    groups: T[],
    tenantId: string,
  ): Promise<T[]> {
    const nested = await resolveNestedModifierGroups(this.prisma, groups, {
      tenantId,
    });
    if (nested.length === 0) return groups;
    const have = new Set(groups.map((g) => g.id));
    return [...groups, ...(nested.filter((g) => !have.has(g.id)) as T[])];
  }

  /**
   * Deep-copy a modifier group: a new group plus brand-new modifiers of its
   * own, every one with a fresh PLU.
   *
   * Nothing is shared with the original. Renaming or repricing the copy must
   * never touch the group it came from, which rules out reusing the source's
   * ModifierOption rows or array-attaching them — that is what "Add Existing"
   * is for, and it is the opposite of what duplicating means.
   *
   * The copy takes everything the operator can SEE on the original, so
   * array-attached modifiers are copied too: a group listing 28 modifiers
   * duplicates into 28, not just the FK-owned handful.
   */
  async duplicateModifierGroup(groupId: string, tenantId: string) {
    const group = await this.prisma.modifierGroup.findUnique({
      where: { id: groupId },
      include: { options: { orderBy: { sortOrder: "asc" } } },
    });
    if (!group)
      throw new NotFoundException(`Modifier group ${groupId} not found`);
    await this.assertBrandAccess(group.brandId, tenantId);

    const merged = await this.mergeArrayAttachedOptions([group], tenantId);
    const sourceOptions = (merged[0]?.options ?? group.options) as typeof group.options;

    // Generate every PLU up front. Inside a create() the new rows aren't
    // visible to the generator's collision check yet, so track what this
    // batch has already issued as well.
    const plu = await this.plu.generateUnique("modifierGroup", tenantId);
    const issued = new Set<string>();
    const optionPlus: string[] = [];
    for (let i = 0; i < sourceOptions.length; i++) {
      let candidate = await this.plu.generateUnique("modifier", tenantId);
      while (issued.has(candidate)) {
        candidate = await this.plu.generateUnique("modifier", tenantId);
      }
      issued.add(candidate);
      optionPlus.push(candidate);
    }

    return this.prisma.modifierGroup.create({
      data: {
        brandId: group.brandId,
        // Same location, so the copy lands in the catalogue the operator is
        // looking at rather than turning into a brand-wide group.
        locationId: group.locationId,
        name: `${group.name} (copy)`,
        description: group.description,
        plu,
        minSelections: group.minSelections,
        maxSelections: group.maxSelections,
        isRequired: group.isRequired,
        selectionType: group.selectionType,
        allowDuplicateSelections: group.allowDuplicateSelections,
        visibleToCustomers: group.visibleToCustomers,
        sortOrder: group.sortOrder,
        // Not attached to any menu or product yet — the operator duplicates a
        // group to use it somewhere else, and deciding where is their call.
        menuIds: [],
        options: {
          create: sourceOptions.map((o, i) => ({
            name: o.name,
            description: o.description,
            plu: optionPlus[i],
            priceAdjustment: o.priceAdjustment,
            pricesBySize: o.pricesBySize as any,
            // Per-size PLUs would collide with the original's, and they point
            // at the source product's sizes anyway. Start clean.
            skuPlus: {} as any,
            platformPricingOverrides: o.platformPricingOverrides as any,
            imageUrl: o.imageUrl,
            allergens: o.allergens,
            isDefault: o.isDefault,
            isAvailable: o.isAvailable,
            visibleToCustomers: o.visibleToCustomers,
            deliveryTax: o.deliveryTax,
            takeawayTax: o.takeawayTax,
            eatInTax: o.eatInTax,
            nestedGroupId: o.nestedGroupId,
            sortOrder: i,
            menuIds: [],
            // modifierGroupIds deliberately left empty: the copy's modifiers
            // belong to the copy alone.
          })),
        },
      },
      include: { options: { orderBy: { sortOrder: "asc" } } },
    });
  }

  /**
   * Copy a single modifier into the same group, with a fresh PLU.
   * Lands at the end of the list so the original keeps its position.
   */
  async duplicateModifierOption(optionId: string, tenantId: string) {
    const option = await this.prisma.modifierOption.findUnique({
      where: { id: optionId },
    });
    if (!option)
      throw new NotFoundException(`Modifier ${optionId} not found`);
    await this.assertModifierGroupAccess(option.groupId, tenantId);

    const plu = await this.plu.generateUnique("modifier", tenantId);
    const maxOrder = await this.prisma.modifierOption.aggregate({
      where: { groupId: option.groupId },
      _max: { sortOrder: true },
    });

    return this.prisma.modifierOption.create({
      data: {
        groupId: option.groupId,
        name: `${option.name} (copy)`,
        description: option.description,
        plu,
        priceAdjustment: option.priceAdjustment,
        pricesBySize: option.pricesBySize as any,
        skuPlus: {} as any,
        platformPricingOverrides: option.platformPricingOverrides as any,
        imageUrl: option.imageUrl,
        allergens: option.allergens,
        isDefault: false, // two defaults in a pick-one group is a broken menu
        isAvailable: option.isAvailable,
        visibleToCustomers: option.visibleToCustomers,
        deliveryTax: option.deliveryTax,
        takeawayTax: option.takeawayTax,
        eatInTax: option.eatInTax,
        nestedGroupId: option.nestedGroupId,
        sortOrder: (maxOrder._max.sortOrder ?? -1) + 1,
        menuIds: [],
        // Attached only to its own group, not the source's extra groups.
      },
    });
  }

  async createModifierGroup(
    brandId: string,
    tenantId: string,
    dto: {
      name: string;
      description?: string;
      minSelections?: number;
      maxSelections?: number;
      isRequired?: boolean;
      selectionType?: "VARIANT" | "ADDON";
      allowDuplicateSelections?: boolean;
      plu?: string;
      menuIds?: string[];
      // Phase AP — Products section is location-scoped.
      locationId?: string;
    },
  ) {
    await this.assertBrandAccess(brandId, tenantId);
    const explicitPlu = dto.plu?.trim();
    const plu = explicitPlu || (await this.plu.generateUnique("modifierGroup", tenantId));
    return this.prisma.modifierGroup.create({
      data: {
        brandId,
        ...(dto.locationId && { locationId: dto.locationId }),
        name: dto.name,
        description: dto.description ?? null,
        plu,
        minSelections: dto.minSelections ?? 0,
        maxSelections: dto.maxSelections ?? null,
        isRequired: dto.isRequired ?? false,
        selectionType: dto.selectionType ?? "VARIANT",
        allowDuplicateSelections: dto.allowDuplicateSelections ?? false,
        menuIds: dto.menuIds ?? [],
      },
      include: { options: true },
    });
  }

  async updateModifierGroup(
    groupId: string,
    tenantId: string,
    dto: {
      name?: string;
      description?: string;
      minSelections?: number;
      maxSelections?: number | null;
      isRequired?: boolean;
      selectionType?: "VARIANT" | "ADDON";
      allowDuplicateSelections?: boolean;
      plu?: string;
      visibleToCustomers?: boolean;
      menuIds?: string[];
    },
  ) {
    await this.assertModifierGroupAccess(groupId, tenantId);
    return this.prisma.modifierGroup.update({
      where: { id: groupId },
      data: {
        ...(dto.name && { name: dto.name }),
        ...(dto.description !== undefined && { description: dto.description }),
        ...(dto.minSelections !== undefined && { minSelections: dto.minSelections }),
        ...(dto.maxSelections !== undefined && { maxSelections: dto.maxSelections }),
        ...(dto.isRequired !== undefined && { isRequired: dto.isRequired }),
        // Phase AL fields.
        ...(dto.selectionType !== undefined && { selectionType: dto.selectionType }),
        ...(dto.allowDuplicateSelections !== undefined && {
          allowDuplicateSelections: dto.allowDuplicateSelections,
        }),
        ...(dto.plu !== undefined && { plu: dto.plu }),
        ...(dto.visibleToCustomers !== undefined && {
          visibleToCustomers: dto.visibleToCustomers,
        }),
        ...(dto.menuIds !== undefined && { menuIds: dto.menuIds }),
      },
      include: { options: true },
    });
  }

  async removeModifierGroup(groupId: string, tenantId: string) {
    await this.assertModifierGroupAccess(groupId, tenantId);
    await this.prisma.modifierGroup.delete({ where: { id: groupId } });
  }

  // ── Many-to-many: ModifierOption ↔ ModifierGroup ─────────────────────────
  //
  // Phase AL: same modifier (e.g. "Extra cheese") can belong to many
  // groups. Schema keeps `groupId` as a single FK for the "primary"
  // group (legacy + sort order) and a `modifierGroupIds[]` array for
  // additional memberships. Attach/detach operates on the array; the
  // primary FK never changes here.
  async attachModifierToGroup(
    groupId: string,
    optionId: string,
    tenantId: string,
  ) {
    await this.assertModifierGroupAccess(groupId, tenantId);
    const option = await this.prisma.modifierOption.findFirst({
      where: { id: optionId, group: { brand: { tenantId } } },
    });
    if (!option) throw new NotFoundException("Modifier not found");
    const next = Array.from(
      new Set([...(option.modifierGroupIds ?? []), groupId]),
    );
    return this.prisma.modifierOption.update({
      where: { id: optionId },
      data: { modifierGroupIds: next },
    });
  }

  async detachModifierFromGroup(
    groupId: string,
    optionId: string,
    tenantId: string,
  ) {
    await this.assertModifierGroupAccess(groupId, tenantId);
    const option = await this.prisma.modifierOption.findFirst({
      where: { id: optionId, group: { brand: { tenantId } } },
    });
    if (!option) throw new NotFoundException("Modifier not found");
    // If this is the modifier's primary group, refuse to detach via
    // this path — the operator must move it to a different group first
    // (or delete it). Detaching only operates on the auxiliary array.
    if (option.groupId === groupId) {
      throw new BadRequestException(
        "This is the modifier's primary group. Move or delete the modifier instead.",
      );
    }
    return this.prisma.modifierOption.update({
      where: { id: optionId },
      data: {
        modifierGroupIds: (option.modifierGroupIds ?? []).filter(
          (id) => id !== groupId,
        ),
      },
    });
  }

  async addModifierOption(
    groupId: string,
    tenantId: string,
    dto: {
      name: string;
      priceAdjustment?: number;
      isDefault?: boolean;
      imageUrl?: string;
      allergens?: string[];
      nestedGroupId?: string;
      plu?: string;
      pricesBySize?: Record<string, number>;
      skuPlus?: Record<string, string>;
      platformPricingOverrides?: Record<string, number>;
      menuIds?: string[];
    },
  ) {
    await this.assertModifierGroupAccess(groupId, tenantId);
    const maxOrder = await this.prisma.modifierOption.aggregate({
      where: { groupId },
      _max: { sortOrder: true },
    });
    const explicitPlu = dto.plu?.trim();
    const plu = explicitPlu || (await this.plu.generateUnique("modifier", tenantId));
    return this.prisma.modifierOption.create({
      data: {
        groupId,
        name: dto.name,
        plu,
        priceAdjustment: dto.priceAdjustment ?? 0,
        pricesBySize: (dto.pricesBySize ?? {}) as any,
        skuPlus: (dto.skuPlus ?? {}) as any,
        platformPricingOverrides: (dto.platformPricingOverrides ?? {}) as any,
        isDefault: dto.isDefault ?? false,
        imageUrl: dto.imageUrl ?? null,
        allergens: dto.allergens ?? [],
        nestedGroupId: dto.nestedGroupId ?? null,
        sortOrder: (maxOrder._max.sortOrder ?? -1) + 1,
        menuIds: dto.menuIds ?? [],
      },
    });
  }

  async updateModifierOption(
    optionId: string,
    tenantId: string,
    dto: {
      name?: string;
      priceAdjustment?: number;
      isDefault?: boolean;
      isAvailable?: boolean;
      imageUrl?: string;
      allergens?: string[];
      nestedGroupId?: string | null;
      sortOrder?: number;
      // Phase AL fields.
      plu?: string;
      pricesBySize?: Record<string, number>;
      skuPlus?: Record<string, string>;
      platformPricingOverrides?: Record<string, number>;
      visibleToCustomers?: boolean;
      deliveryTax?: number;
      takeawayTax?: number;
      eatInTax?: number;
      menuIds?: string[];
      /**
       * Phase BN — the groups choosing this option opens, in the order the
       * picker should ask for them. Handled separately from the column
       * updates below because it's join rows, not a field.
       */
      nestedGroupIds?: string[];
    },
  ) {
    const option = await this.prisma.modifierOption.findFirst({
      where: { id: optionId, group: { brand: { tenantId } } },
    });
    if (!option) throw new NotFoundException("Option not found");
    if (dto.nestedGroupIds !== undefined) {
      await this.setNestedModifierGroups(optionId, tenantId, dto.nestedGroupIds);
    }
    return this.prisma.modifierOption.update({
      where: { id: optionId },
      data: {
        ...(dto.name && { name: dto.name }),
        ...(dto.priceAdjustment !== undefined && { priceAdjustment: dto.priceAdjustment }),
        ...(dto.isDefault !== undefined && { isDefault: dto.isDefault }),
        ...(dto.isAvailable !== undefined && { isAvailable: dto.isAvailable }),
        ...(dto.imageUrl !== undefined && { imageUrl: dto.imageUrl }),
        ...(dto.allergens !== undefined && { allergens: dto.allergens }),
        ...(dto.nestedGroupId !== undefined && { nestedGroupId: dto.nestedGroupId }),
        ...(dto.sortOrder !== undefined && { sortOrder: dto.sortOrder }),
        // Phase AL fields.
        ...(dto.plu !== undefined && { plu: dto.plu }),
        ...(dto.pricesBySize !== undefined && {
          pricesBySize: dto.pricesBySize as any,
        }),
        ...(dto.skuPlus !== undefined && { skuPlus: dto.skuPlus as any }),
        ...(dto.platformPricingOverrides !== undefined && {
          platformPricingOverrides: dto.platformPricingOverrides as any,
        }),
        ...(dto.visibleToCustomers !== undefined && {
          visibleToCustomers: dto.visibleToCustomers,
        }),
        ...(dto.deliveryTax !== undefined && { deliveryTax: dto.deliveryTax }),
        ...(dto.takeawayTax !== undefined && { takeawayTax: dto.takeawayTax }),
        ...(dto.eatInTax !== undefined && { eatInTax: dto.eatInTax }),
        ...(dto.menuIds !== undefined && { menuIds: dto.menuIds }),
      },
    });
  }

  async removeModifierOption(optionId: string, tenantId: string) {
    const option = await this.prisma.modifierOption.findFirst({
      where: { id: optionId, group: { brand: { tenantId } } },
    });
    if (!option) throw new NotFoundException("Option not found");
    await this.prisma.modifierOption.delete({ where: { id: optionId } });
  }

  async linkModifierGroupToItem(itemId: string, groupId: string, tenantId: string, sortOrder = 0) {
    await this.assertItemAccess(itemId, tenantId);
    await this.assertModifierGroupAccess(groupId, tenantId);
    try {
      return await this.prisma.modifierGroupOnItem.create({
        data: { itemId, groupId, sortOrder },
        include: { group: { include: { options: true } } },
      });
    } catch {
      throw new ConflictException("Modifier group already linked to this item");
    }
  }

  async unlinkModifierGroupFromItem(itemId: string, groupId: string, tenantId: string) {
    await this.assertItemAccess(itemId, tenantId);
    await this.prisma.modifierGroupOnItem.delete({
      where: { itemId_groupId: { itemId, groupId } },
    });
  }

  // ── Category ↔ Item links ────────────────────────────────────────────────

  async addItemToCategory(categoryId: string, tenantId: string, dto: AddItemToCategoryDto) {
    await this.assertCategoryAccess(categoryId, tenantId);
    await this.assertItemAccess(dto.itemId, tenantId);
    try {
      return await this.prisma.menuItemOnCategory.create({
        data: {
          categoryId,
          itemId: dto.itemId,
          sortOrder: dto.sortOrder ?? 0,
          priceOverride: dto.priceOverride,
        },
        include: { item: true },
      });
    } catch {
      throw new ConflictException("Item already in this category");
    }
  }

  async removeItemFromCategory(categoryId: string, itemId: string, tenantId: string) {
    await this.assertCategoryAccess(categoryId, tenantId);
    await this.prisma.menuItemOnCategory.delete({
      where: { categoryId_itemId: { categoryId, itemId } },
    });
  }

  async reorderItemsInCategory(categoryId: string, tenantId: string, order: Array<{ itemId: string; sortOrder: number }>) {
    await this.assertCategoryAccess(categoryId, tenantId);
    await this.prisma.$transaction(
      order.map(({ itemId, sortOrder }) =>
        this.prisma.menuItemOnCategory.update({
          where: { categoryId_itemId: { categoryId, itemId } },
          data: { sortOrder },
        }),
      ),
    );
  }

  // ── Location-scoped active menu (POS + storefront) ────────────────────────
  //
  // Phase AP — POS only shows a menu when it's been EXPLICITLY published
  // to this location for the POS target. No brand-scoped fallback, no
  // implicit "isActive=true is enough" — until the operator opens the
  // publish modal and ticks "Order Hub POS", the till stays empty.
  //
  // The publish flow stores selected targets in Menu.publishedTo[] and
  // also flips Menu.status to PUBLISHED. We require BOTH:
  //   • status = PUBLISHED         (so a draft can't accidentally show)
  //   • publishedTo contains "POS" (so the operator's intent is explicit)
  //   • locationId = this location (so sibling sites don't leak)
  //
  // Returns a "full menu" structure shaped for POS consumption: every
  // category, every visible item, modifier groups + options, productSkus.
  async findActiveMenuForLocation(locationId: string, tenantId: string) {
    const location = await this.prisma.location.findFirst({
      where: { id: locationId, brand: { tenantId } },
      select: { id: true, brandId: true },
    });
    if (!location) throw new NotFoundException("Location not found");

    // Phase BA — assignment-first: the publish flow writes one
    // MenuChannelAssignment per (location, channel, brand), which is the
    // serving truth. Legacy fallback below keeps un-republished locations
    // working exactly as before.
    const assignedId = await this.menuAssignments.resolveAssignedMenuId({
      locationId,
      channel: "POS",
      preferBrandId: location.brandId,
      requirePublished: true,
    });

    const menu = assignedId
      ? { id: assignedId }
      : await this.prisma.menu.findFirst({
          where: {
            locationId,
            status: "PUBLISHED",
            deletedAt: null,
            publishedTo: { has: "POS" },
          },
          // Most recently published wins when an operator has multiple
          // POS-targeted menus active on a single location.
          orderBy: [{ lastPublishedAt: "desc" }, { updatedAt: "desc" }],
          select: { id: true },
        });
    if (!menu) return null;

    const full = await this.findOne(menu.id, tenantId);

    // Phase AW-14 — strip items currently snoozed for POS so the till
    // never offers an out-of-stock item. Same read-time pattern used by
    // the storefront in OrderingService.getStorefrontBySlug. Single
    // index hit, then in-memory filter. Phase BA: location-scoped
    // snoozes apply here too.
    if (full?.categories?.length) {
      const itemIds: string[] = [];
      for (const cat of full.categories) {
        for (const link of (cat as any).items ?? []) {
          if (link?.item?.id) itemIds.push(link.item.id);
        }
      }
      const snoozed =
        await this.menuAvailability.getSnoozedItemIdsForChannel(
          "POS",
          itemIds,
          locationId,
        );
      if (snoozed.size > 0) {
        for (const cat of full.categories) {
          (cat as any).items = ((cat as any).items ?? []).filter(
            (link: any) => !snoozed.has(link?.item?.id),
          );
        }
      }
    }

    // Every modifier group referenced by a multi-SKU product's sizes.
    //
    // A size's groups live in productSkus[].modifierGroups as bare id
    // strings with no FK, so nothing in the include tree above pulls them.
    // POS was resolving those ids against the brand catalogue alone, which
    // silently drops any group whose brandId differs from the menu's — the
    // ordinary case on a multi-brand tenant. The size then opened with no
    // modifiers at all, while online ordering showed them correctly,
    // because OrderingService.getStorefrontBySlug already does this.
    if (full) {
      (full as any).skuModifierGroups = await this.resolveSkuModifierGroups(
        full,
        tenantId,
      );
      // A flat (non-sized) product renders straight off
      // item.modifierGroupLinks[].group.options, which is the FK-primary set
      // only — anything added through "Add Existing" was missing from the
      // till, so a group holding a dozen toppings offered four.
      await this.foldItemLinkedGroupOptions(full, tenantId);

      // Phase BN — groups that hang off an OPTION ("Make It a Meal" opening a
      // sides and a drinks picker). Unreachable from item.modifierGroupLinks
      // at any include depth, so the till had the meal option but nothing to
      // open — online ordering drilled down and the POS didn't, because
      // OrderingService.getStorefrontBySlug resolves these and this didn't.
      //
      // Runs AFTER the folds above so array-attached options are present and
      // their own nested groups get followed too.
      (full as any).nestedModifierGroups = await this.resolveNestedForMenu(
        full,
        tenantId,
      );
    }

    return full;
  }

  /**
   * Every group reachable from a menu's options, at any nesting depth.
   *
   * Returned as a flat list the till indexes by id, alongside
   * skuModifierGroups — same mechanism, because a nested group is invisible
   * to the menu's own includes for the same reason a per-size group is.
   */
  private async resolveNestedForMenu(menu: any, tenantId: string) {
    const roots: any[] = [...((menu as any).skuModifierGroups ?? [])];
    for (const cat of menu?.categories ?? []) {
      for (const link of cat?.items ?? []) {
        for (const gl of link?.item?.modifierGroupLinks ?? []) {
          if (gl?.group?.options) roots.push(gl.group);
        }
      }
    }
    if (roots.length === 0) return [];
    const nested = await resolveNestedModifierGroups(this.prisma, roots, {
      tenantId,
    });
    if (nested.length === 0) return [];
    // Nested groups have the same FK-only blind spot as any other group.
    const merged = await this.mergeArrayAttachedOptions(nested as any, tenantId);
    // Re-resolve so options folded in above also carry their own nesting.
    await resolveNestedModifierGroups(this.prisma, merged as any, { tenantId });
    return merged;
  }

  /**
   * Fold array-attached modifiers into the groups hanging off a menu's items,
   * in place. mergeArrayAttachedOptions returns copies, so write the merged
   * options back onto the original nodes in the menu tree.
   */
  private async foldItemLinkedGroupOptions(menu: any, tenantId: string) {
    const groups: any[] = [];
    for (const cat of menu?.categories ?? []) {
      for (const link of cat?.items ?? []) {
        for (const gl of link?.item?.modifierGroupLinks ?? []) {
          if (gl?.group?.options) groups.push(gl.group);
        }
      }
    }
    if (groups.length === 0) return;
    const merged = await this.mergeArrayAttachedOptions(groups, tenantId);
    merged.forEach((m: any, i: number) => {
      groups[i].options = m.options;
    });
  }

  /**
   * Resolve productSkus[].modifierGroups ids across a menu into full group
   * rows. Tenant-guarded, and by id rather than by brand so a group attached
   * to a size from another brand's catalogue still comes back.
   */
  private async resolveSkuModifierGroups(menu: any, tenantId: string) {
    const ids = new Set<string>();
    for (const cat of menu?.categories ?? []) {
      for (const link of cat?.items ?? []) {
        const skus = link?.item?.productSkus;
        if (!Array.isArray(skus)) continue;
        for (const sku of skus) {
          for (const gid of sku?.modifierGroups ?? []) {
            if (typeof gid === "string" && gid) ids.add(gid);
          }
        }
      }
    }
    return this.loadGroupsByIds(ids, tenantId);
  }

  /**
   * Groups behind a set of bare ids, scoped by TENANT rather than brand.
   *
   * `productSkus[].modifierGroups` is a JSON array with no FK, so the only way
   * to render a sized product's options is to look the ids up directly. It has
   * to be tenant-scoped: a menu imported under one brand routinely references
   * groups on another brand of the same tenant, and every brand- or
   * location-scoped list is therefore incomplete by construction.
   */
  private async loadGroupsByIds(ids: Set<string>, tenantId: string) {
    if (ids.size === 0) return [];
    const groups = await this.prisma.modifierGroup.findMany({
      where: { id: { in: Array.from(ids) }, brand: { tenantId } },
      include: {
        options: { orderBy: { sortOrder: "asc" } },
        _count: { select: { itemLinks: true } },
      },
      orderBy: { name: "asc" },
    });
    // Same array-attach fold the brand-wide list does, or a group whose
    // modifiers were all added via "Add Existing" comes back with none.
    return this.mergeArrayAttachedOptions(groups, tenantId);
  }

  // ── Public menu (for online ordering) ────────────────────────────────────

  async findPublishedByBrand(brandId: string) {
    return this.prisma.menu.findFirst({
      where: { brandId, status: "PUBLISHED", deletedAt: null, isActive: true },
      include: {
        categories: {
          where: { isVisible: true },
          orderBy: { sortOrder: "asc" },
          include: {
            items: {
              where: { isVisible: true, item: { isAvailable: true } },
              orderBy: { sortOrder: "asc" },
              include: {
                item: {
                  include: {
                    modifierGroupLinks: {
                      include: {
                        group: {
                          include: {
                            options: {
                              where: { isAvailable: true },
                              orderBy: { sortOrder: "asc" },
                            },
                          },
                        },
                      },
                      orderBy: { sortOrder: "asc" },
                    },
                    variants: { where: { isAvailable: true }, orderBy: { sortOrder: "asc" } },
                  },
                },
              },
            },
          },
        },
      },
    });
  }

  // ── Access guards ──────────────────────────────────────────────────────────

  // Per-user catalog access. Admins (tenant-wide) see everything; every
  // other user is limited to the locations/brands they're assigned to, so
  // the Products tab only shows products for locations they can access.
  //   locationIds = UserLocation ∪ (all locations of ASSIGNED brands)
  //   brandIds    = UserBrand ∪ (brands of their direct UserLocations)
  // A single UserLocation does NOT unlock the brand's OTHER locations — a
  // user with a,b,c never gains d just because it shares a brand.
  // Returns null/null for admins = no restriction.
  private async resolveCatalogScope(
    user: AuthenticatedUser,
  ): Promise<{ locationIds: string[] | null; brandIds: string[] | null }> {
    if (["PLATFORM_ADMIN", "TENANT_OWNER"].includes(String(user.role))) {
      return { locationIds: null, brandIds: null };
    }
    const [locs, brands] = await Promise.all([
      (this.prisma as any).userLocation.findMany({
        where: { userId: user.userId },
        select: { locationId: true },
      }),
      (this.prisma as any).userBrand.findMany({
        where: { userId: user.userId },
        select: { brandId: true },
      }),
    ]);
    const directLocationIds: string[] = locs.map((l: any) => l.locationId);
    const directBrandIds: string[] = brands.map((b: any) => b.brandId);
    const locationIds = new Set<string>(directLocationIds);
    const brandIds = new Set<string>(directBrandIds);

    // Assigned brands unlock ALL their locations.
    if (directBrandIds.length) {
      const brandRows = await this.prisma.brand.findMany({
        where: { id: { in: directBrandIds }, tenantId: user.tenantId },
        select: { primaryLocationId: true, locations: { select: { id: true } } },
      });
      for (const b of brandRows) {
        if ((b as any).primaryLocationId)
          locationIds.add((b as any).primaryLocationId);
        for (const l of b.locations) locationIds.add(l.id);
      }
    }
    // Brands the user's direct locations belong to → they may view those
    // brands' item library (but NOT the brands' other locations).
    if (directLocationIds.length) {
      const locRows = await this.prisma.location.findMany({
        where: { id: { in: directLocationIds }, brand: { tenantId: user.tenantId } },
        select: { brandId: true },
      });
      for (const l of locRows) if (l.brandId) brandIds.add(l.brandId);
    }
    return { locationIds: Array.from(locationIds), brandIds: Array.from(brandIds) };
  }

  private async assertBrandAccess(brandId: string, tenantId: string) {
    const brand = await this.prisma.brand.findFirst({
      where: { id: brandId, tenantId, deletedAt: null },
    });
    if (!brand) throw new NotFoundException("Brand not found");
    return brand;
  }

  /** Phase AP — used by every location-scoped endpoint
   *  (findAllByLocation, findItemsByLocation, findModifierGroupsByLocation). */
  private async assertLocationAccess(locationId: string, tenantId: string) {
    const location = await this.prisma.location.findFirst({
      where: { id: locationId, deletedAt: null, brand: { tenantId } },
      select: { id: true, brandId: true },
    });
    if (!location) throw new NotFoundException("Location not found");
    return location;
  }

  private async assertMenuAccess(menuId: string, tenantId: string) {
    const menu = await this.prisma.menu.findFirst({
      where: { id: menuId, deletedAt: null, brand: { tenantId } },
    });
    if (!menu) throw new NotFoundException("Menu not found");
    return menu;
  }

  private async assertCategoryAccess(categoryId: string, tenantId: string) {
    const cat = await this.prisma.menuCategory.findFirst({
      where: { id: categoryId, menu: { brand: { tenantId } } },
    });
    if (!cat) throw new NotFoundException("Category not found");
    return cat;
  }

  private async assertItemAccess(itemId: string, tenantId: string) {
    // MenuItem has brandId (FK) but no Prisma relation to Brand; verify via join
    const item = await this.prisma.menuItem.findUnique({ where: { id: itemId } });
    if (!item) throw new NotFoundException("Menu item not found");
    const brand = await this.prisma.brand.findFirst({ where: { id: item.brandId, tenantId } });
    if (!brand) throw new NotFoundException("Menu item not found");
    return item;
  }

  private async assertModifierGroupAccess(groupId: string, tenantId: string) {
    const group = await this.prisma.modifierGroup.findFirst({
      where: { id: groupId, brand: { tenantId } },
    });
    if (!group) throw new NotFoundException("Modifier group not found");
    return group;
  }

  /**
   * Phase BA-5 — public cover-image proxy.
   *
   * Menu banners are uploaded inline and stored as `data:` URLs (no cloud
   * storage yet), which external platforms like Deliveroo can't fetch. This
   * resolves the menu's cover (banner → hero → logo → brand logo) and returns
   * the raw image bytes so a stable, public https URL points at a real image.
   * `http(s)` sources are proxied through; `data:` URLs are decoded. Public by
   * opaque menu id — same trust model as the HubRise image proxy.
   */
  async getMenuCoverImage(
    menuId: string,
  ): Promise<{ buffer: Buffer; contentType: string }> {
    const menu = await this.prisma.menu.findFirst({
      where: { id: menuId, deletedAt: null },
      select: {
        bannerImage: true,
        heroImage: true,
        logoImage: true,
        brand: { select: { logoUrl: true } },
      },
    });
    if (!menu) throw new NotFoundException("Menu not found");
    const src =
      menu.bannerImage ||
      menu.heroImage ||
      menu.logoImage ||
      menu.brand?.logoUrl ||
      "";

    // data:[<mime>][;base64],<data>
    const dataUrl = /^data:([^;,]*)(;base64)?,([\s\S]*)$/i.exec(src);
    if (dataUrl) {
      const contentType = dataUrl[1] || "image/jpeg";
      const payload = dataUrl[3] ?? "";
      const buffer = dataUrl[2]
        ? Buffer.from(payload, "base64")
        : Buffer.from(decodeURIComponent(payload), "utf8");
      return { buffer, contentType };
    }

    if (/^https?:\/\//i.test(src)) {
      const res = await fetch(src);
      if (!res.ok) {
        throw new NotFoundException(`Cover image fetch failed (${res.status})`);
      }
      const contentType = res.headers.get("content-type") ?? "image/jpeg";
      const buffer = Buffer.from(await res.arrayBuffer());
      return { buffer, contentType };
    }

    throw new NotFoundException("No usable cover image for this menu");
  }

  // ── Channel pricing: one percentage per channel, applied menu-wide ────────
  //
  // Marketplaces charge commission, so the same dish has to list higher on
  // Uber than it does on your own site. Doing that per product is the job
  // this replaces: an operator setting a 20% Uber uplift across 600 products
  // one modal at a time will not finish, and a menu imported FROM a
  // marketplace arrives with the uplift baked into its base prices, where
  // nobody can see it or take it back out. (That is exactly how De Salt's
  // menu ended up 20% high on POS and its own website.)
  //
  // The uplift is stored as a per-channel OVERRIDE, never folded into
  // basePrice, so the base menu stays true and the markup stays visible,
  // adjustable, and reversible.
  async applyChannelPricing(
    menuId: string,
    tenantId: string,
    dto: {
      brandId: string;
      channels: Array<{ channelKey: string; name?: string; percent: number }>;
    },
  ) {
    const menu = await this.prisma.menu.findFirst({
      where: { id: menuId, brand: { tenantId } },
      select: { id: true, pricingVariants: true },
    });
    if (!menu) throw new NotFoundException("Menu not found");

    const brand = await this.prisma.brand.findFirst({
      where: { id: dto.brandId, tenantId },
      select: { id: true, name: true },
    });
    if (!brand) throw new BadRequestException("Brand not found");

    const round2 = (n: number) => Math.round(n * 100) / 100;
    const uplift = (base: number, pct: number) => round2(base * (1 + pct / 100));

    // Register each channel as a brand×channel variant, so the existing
    // per-product modal, the HubRise catalog and every publisher see these
    // exactly as they'd see a hand-made one. Same refs, no parallel concept.
    const existing: PricingVariant[] = Array.isArray(menu.pricingVariants)
      ? (menu.pricingVariants as any)
      : [];
    const byRef = new Map(existing.map((v) => [v.ref, v]));
    // Registration happens AFTER the sweep, once every brand the menu's
    // products actually belong to is known — see seenBrands.

    // Everything this menu serves. Items carry the base price, SKUs carry
    // per-size prices, and modifier options carry their own — a 20% uplift
    // that missed the modifiers would undercharge every meal upgrade.
    const cats = await this.prisma.menuCategory.findMany({
      where: { menuId },
      select: {
        items: {
          select: {
            item: {
              select: {
                id: true,
                basePrice: true,
                productSkus: true,
                platformPricingOverrides: true,
                // The brand is a property of the PRODUCT, not the menu. A menu
                // can carry products from a different brand than its own — and
                // when it does, keying the uplift to the menu's brand writes
                // refs no publisher will ever resolve, because variants are
                // matched against the product's brand.
                brandId: true,
                brandIds: true,
              },
            },
          },
        },
      },
    });
    const items = new Map<string, any>();
    for (const c of cats) for (const l of c.items) items.set(l.item.id, l.item);

    // Brands actually encountered on the menu's ROWS. Deliberately not seeded
    // with the menu's own brand: a menu whose products all belong to another
    // brand would otherwise get a full set of variants for a brand with
    // nothing to price, which is what filled the Pricing variants list with
    // groups the operator had no use for.
    const seenBrands = new Set<string>();
    /** The brands to key this row's overrides by, never an empty list. */
    const brandsFor = (row: { brandId?: string | null; brandIds?: string[] }) => {
      const out = new Set<string>();
      if (row.brandId) out.add(row.brandId);
      for (const b of row.brandIds ?? []) if (b) out.add(b);
      // Nothing on the row — fall back to the menu's brand rather than
      // skipping, so a product with no brand still gets its uplift.
      if (out.size === 0) out.add(brand.id);
      for (const b of out) seenBrands.add(b);
      return [...out];
    };

    let itemsUpdated = 0;
    let skusUpdated = 0;
    for (const item of items.values()) {
      const itemBrands = brandsFor(item);
      const overrides: Record<string, any> = {
        ...((item.platformPricingOverrides as any) ?? {}),
      };
      const base = Number(item.basePrice) || 0;
      let touched = false;

      for (const ch of dto.channels) {
        for (const b of itemBrands) {
          const ref = brandChannelRef(b, ch.channelKey);
          // 0% means "same as base". Blank is what the per-product modal calls
          // a default price, so clear the key rather than writing base twice —
          // otherwise changing the base later silently stops applying here.
          if (ch.percent === 0) {
            if (ref in overrides) { delete overrides[ref]; touched = true; }
            continue;
          }
          overrides[ref] = uplift(base, ch.percent);
          touched = true;
        }
      }

      const skus = Array.isArray(item.productSkus) ? [...item.productSkus] : [];
      let skusTouched = false;
      const nextSkus = skus.map((sku: any) => {
        const po: Record<string, any> = { ...(sku.priceOverrides ?? {}) };
        for (const ch of dto.channels) {
          for (const b of itemBrands) {
            const ref = brandChannelRef(b, ch.channelKey);
            if (ch.percent === 0) {
              if (ref in po) { delete po[ref]; skusTouched = true; }
              continue;
            }
            po[ref] = uplift(Number(sku.price) || 0, ch.percent);
            skusTouched = true;
          }
        }
        return { ...sku, priceOverrides: po };
      });
      if (skusTouched) skusUpdated += nextSkus.length;

      if (touched || skusTouched) {
        await this.prisma.menuItem.update({
          where: { id: item.id },
          data: {
            ...(touched ? { platformPricingOverrides: overrides as any } : {}),
            ...(skusTouched ? { productSkus: nextSkus as any } : {}),
          },
        });
        itemsUpdated++;
      }
    }

    // Modifier options reachable from this menu — including nested ones, which
    // hang off an option and so never appear in an item's own group links.
    const groupIds = await this.reachableGroupIdsForMenu(menuId, tenantId);
    let optionsUpdated = 0;
    if (groupIds.length) {
      const options = await this.prisma.modifierOption.findMany({
        where: { groupId: { in: groupIds } },
        select: {
          id: true,
          priceAdjustment: true,
          platformPricingOverrides: true,
          // Same rule as items: the option's price belongs to its group's
          // brand, which need not be the menu's.
          group: { select: { brandId: true } },
        },
      });
      for (const o of options) {
        const po: Record<string, any> = {
          ...((o.platformPricingOverrides as any) ?? {}),
        };
        let touched = false;
        const optBrands = brandsFor({ brandId: (o as any).group?.brandId });
        for (const ch of dto.channels) {
          for (const b of optBrands) {
            const ref = brandChannelRef(b, ch.channelKey);
            if (ch.percent === 0) {
              if (ref in po) { delete po[ref]; touched = true; }
              continue;
            }
            po[ref] = uplift(Number(o.priceAdjustment) || 0, ch.percent);
            touched = true;
          }
        }
        if (touched) {
          await this.prisma.modifierOption.update({
            where: { id: o.id },
            data: { platformPricingOverrides: po as any },
          });
          optionsUpdated++;
        }
      }
    }

    const brandNames = new Map(
      (
        await this.prisma.brand.findMany({
          where: { id: { in: [...seenBrands] }, tenantId },
          select: { id: true, name: true },
        })
      ).map((b) => [b.id, b.name]),
    );
    for (const b of seenBrands) {
      for (const ch of dto.channels) {
        const ref = brandChannelRef(b, ch.channelKey);
        byRef.set(ref, {
          ref,
          name: `${brandNames.get(b) ?? brand.name} — ${ch.name ?? ch.channelKey}`,
          channelKey: ch.channelKey,
          brandId: b,
        });
      }
    }

    await this.prisma.menu.update({
      where: { id: menuId },
      data: { pricingVariants: [...byRef.values()] as any },
    });

    this.logger.log(
      `Channel pricing on menu ${menuId} across ${seenBrands.size} brand(s): ` +
        dto.channels.map((c) => `${c.channelKey} +${c.percent}%`).join(", ") +
        ` → ${itemsUpdated} items, ${skusUpdated} sizes, ${optionsUpdated} options`,
    );

    return {
      brandId: brand.id,
      channels: dto.channels,
      itemsUpdated,
      skusUpdated,
      optionsUpdated,
    };
  }

  /** Every modifier group this menu can reach, nested ones included. */
  private async reachableGroupIdsForMenu(
    menuId: string,
    tenantId: string,
  ): Promise<string[]> {
    const cats = await this.prisma.menuCategory.findMany({
      where: { menuId },
      select: {
        items: {
          select: {
            item: {
              select: {
                productSkus: true,
                modifierGroupLinks: { select: { groupId: true } },
              },
            },
          },
        },
      },
    });
    const ids = new Set<string>();
    for (const c of cats) {
      for (const l of c.items) {
        for (const g of l.item.modifierGroupLinks ?? []) ids.add(g.groupId);
        // A sized product routes its groups through the SKU, where they are
        // bare ids with no FK — miss these and every pizza's crust list keeps
        // its old price. See [[feedback-sku-modifier-groups-no-fk]].
        for (const sku of (l.item.productSkus as any[]) ?? []) {
          for (const gid of sku?.modifierGroups ?? []) {
            if (typeof gid === "string" && gid) ids.add(gid);
          }
        }
      }
    }
    if (ids.size === 0) return [];
    const resolved = await resolveNestedModifierGroups(
      this.prisma,
      await this.prisma.modifierGroup.findMany({
        where: { id: { in: [...ids] }, brand: { tenantId } },
        include: { options: true },
      }),
      { tenantId },
    );
    for (const g of resolved) {
      ids.add(g.id);
      for (const n of (g as any).nestedGroups ?? []) ids.add(n.id);
    }
    return [...ids];
  }

}
