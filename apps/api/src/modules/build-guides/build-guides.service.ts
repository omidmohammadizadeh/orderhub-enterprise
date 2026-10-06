import { BadRequestException, Injectable, NotFoundException, Optional } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import {
  BUILD_GUIDE_MAX_STEPS,
  buildGuideNameKey,
  type BuildGuideDto,
  type BuildGuideStep,
} from "@orderhub/shared";
import { PrismaService } from "../../infrastructure/database/prisma.service";
import { SupabaseStorageService } from "../uploads/supabase-storage.service";
import { rehostImageIfInline } from "../uploads/rehost-image";
import { pickKeysForOrderLines } from "./name-key-match";

export interface SaveBuildGuideInput {
  steps?: unknown;
  packNote?: unknown;
}

const MAX_TEXT = 1000;
const MAX_SHORT = 80;

function clip(v: unknown, max: number): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t ? t.slice(0, max) : null;
}

/**
 * "How to build" guides — one per brand + product name (see BuildGuide in
 * schema.prisma for why it is the name and not the MenuItem id).
 */
@Injectable()
export class BuildGuidesService {
  constructor(
    private readonly prisma: PrismaService,
    @Optional() private readonly storage?: SupabaseStorageService,
  ) {}

  /** The guide for a product, or null when it has none yet. */
  async getForItem(itemId: string, tenantId: string): Promise<BuildGuideDto | null> {
    const item = await this.assertItem(itemId, tenantId);
    const row = await this.prisma.buildGuide.findUnique({
      where: { brandId_nameKey: { brandId: item.brandId, nameKey: buildGuideNameKey(item.name) } },
    });
    return row ? this.toDto(row) : null;
  }

  /**
   * Create or replace the guide for a product. A guide saved with no steps
   * and no pack note is removed — that is what "clear the guide" looks like
   * from the editor.
   */
  async saveForItem(
    itemId: string,
    tenantId: string,
    input: SaveBuildGuideInput,
    userId?: string,
  ): Promise<BuildGuideDto | null> {
    const item = await this.assertItem(itemId, tenantId);
    const nameKey = buildGuideNameKey(item.name);
    if (!nameKey) throw new BadRequestException("This product has no name to attach a guide to");

    const steps = await this.cleanSteps(input.steps, tenantId);
    const packNote = clip(input.packNote, MAX_TEXT);
    const where = { brandId_nameKey: { brandId: item.brandId, nameKey } };

    if (steps.length === 0 && !packNote) {
      await this.prisma.buildGuide.deleteMany({ where: { brandId: item.brandId, nameKey } });
      return null;
    }

    const row = await this.prisma.buildGuide.upsert({
      where,
      create: {
        tenantId,
        brandId: item.brandId,
        nameKey,
        name: item.name,
        steps: steps as any,
        packNote,
        updatedBy: userId ?? null,
      },
      update: { name: item.name, steps: steps as any, packNote, updatedBy: userId ?? null },
    });
    return this.toDto(row);
  }

  /**
   * Every guide key in the tenant — tiny, cached by the dashboard so an order
   * card can decide whether to show "How to build" without a request per card.
   */
  async listKeys(tenantId: string): Promise<Array<{ brandId: string; nameKey: string }>> {
    return this.prisma.buildGuide.findMany({
      where: { tenantId },
      select: { brandId: true, nameKey: true },
    });
  }

  /**
   * The guides for each line of an order. Preference per line: a guide of the
   * product's own brand, then of the order's brand, then any brand in the
   * tenant (a location's brand is often a placeholder, and marketplace lines
   * have no product at all).
   */
  async forOrder(orderId: string, tenantId: string) {
    const order = await this.prisma.order.findFirst({
      where: { id: orderId, tenantId },
      select: {
        id: true,
        brandId: true,
        items: {
          select: { id: true, name: true, quantity: true, modifiers: true, notes: true, menuItemId: true },
        },
      },
    });
    if (!order) throw new NotFoundException("Order not found");

    const keys = await this.listKeys(tenantId);
    const picks = await pickKeysForOrderLines(this.prisma, order as any, keys);

    const wanted = picks.filter(Boolean) as Array<{ brandId: string | null; nameKey: string }>;
    const rows = wanted.length
      ? await this.prisma.buildGuide.findMany({
          where: { tenantId, nameKey: { in: [...new Set(wanted.map((w) => w.nameKey))] } },
          orderBy: { updatedAt: "desc" },
        })
      : [];

    return {
      orderId: order.id,
      lines: order.items.map((l: any, i: number) => {
        const pick = picks[i];
        const row = pick
          ? rows.find((r: any) => r.nameKey === pick.nameKey && (!pick.brandId || r.brandId === pick.brandId))
          : undefined;
        return { ...this.line(l), guide: row ? this.toDto(row) : null };
      }),
    };
  }

  /**
   * Every product on a menu that has a guide, grouped by category in menu
   * order — the feed for the printable A4 build charts.
   */
  async forMenu(menuId: string, tenantId: string) {
    const menu = await this.prisma.menu.findFirst({
      where: { id: menuId, deletedAt: null, brand: { tenantId } },
      select: {
        id: true,
        name: true,
        brand: { select: { name: true } },
        categories: {
          orderBy: { sortOrder: "asc" },
          select: {
            name: true,
            items: {
              orderBy: { sortOrder: "asc" },
              select: { item: { select: { id: true, name: true, brandId: true, imageUrl: true } } },
            },
          },
        },
      },
    });
    if (!menu) throw new NotFoundException("Menu not found");

    const items = menu.categories.flatMap((c: any) => c.items.map((l: any) => l.item).filter(Boolean));
    const brandIds = [...new Set(items.map((i: any) => i.brandId))] as string[];
    const rows = brandIds.length
      ? await this.prisma.buildGuide.findMany({ where: { tenantId, brandId: { in: brandIds } } })
      : [];
    const byKey = new Map<string, any>(rows.map((r: any) => [`${r.brandId}|${r.nameKey}`, r]));

    const seen = new Set<string>();
    const categories = menu.categories
      .map((c: any) => ({
        name: c.name,
        items: c.items
          .map((l: any) => l.item)
          .filter((i: any) => i && !seen.has(i.id))
          .map((i: any) => {
            const row = byKey.get(`${i.brandId}|${buildGuideNameKey(i.name)}`);
            if (!row) return null;
            seen.add(i.id);
            return { id: i.id, name: i.name, imageUrl: i.imageUrl ?? null, guide: this.toDto(row) };
          })
          .filter(Boolean),
      }))
      .filter((c: any) => c.items.length > 0);

    return { menuId: menu.id, menuName: menu.name, brandName: menu.brand?.name ?? null, categories };
  }

  /** One product with its guide, for printing a single chart. */
  async forItemPrint(itemId: string, tenantId: string) {
    const item = await this.prisma.menuItem.findUnique({
      where: { id: itemId },
      select: { id: true, name: true, brandId: true, imageUrl: true },
    });
    const guide = await this.getForItem(itemId, tenantId); // also the tenant check
    const brand = await this.prisma.brand.findFirst({ where: { id: item!.brandId }, select: { name: true } });
    return {
      menuId: null,
      menuName: null,
      brandName: brand?.name ?? null,
      categories: guide
        ? [{ name: "", items: [{ id: item!.id, name: item!.name, imageUrl: item!.imageUrl ?? null, guide }] }]
        : [],
    };
  }

  // ── helpers ────────────────────────────────────────────────────────────────

  private line(l: any) {
    return {
      orderItemId: l.id,
      name: l.name,
      quantity: l.quantity,
      modifiers: Array.isArray(l.modifiers) ? l.modifiers : [],
      notes: l.notes ?? null,
    };
  }

  private async assertItem(itemId: string, tenantId: string) {
    // MenuItem has a bare brandId and NO brand relation — check the brand separately.
    const item = await this.prisma.menuItem.findUnique({
      where: { id: itemId },
      select: { id: true, brandId: true, name: true },
    });
    if (!item) throw new NotFoundException("Menu item not found");
    const brand = await this.prisma.brand.findFirst({
      where: { id: item.brandId, tenantId },
      select: { id: true },
    });
    if (!brand) throw new NotFoundException("Menu item not found");
    return item;
  }

  private async cleanSteps(raw: unknown, tenantId: string): Promise<BuildGuideStep[]> {
    if (raw == null) return [];
    if (!Array.isArray(raw)) throw new BadRequestException("steps must be a list");
    if (raw.length > BUILD_GUIDE_MAX_STEPS) {
      throw new BadRequestException(`A guide can have at most ${BUILD_GUIDE_MAX_STEPS} steps`);
    }
    const out: BuildGuideStep[] = [];
    for (const s of raw) {
      if (!s || typeof s !== "object") continue;
      const src = s as Record<string, unknown>;
      const text = clip(src.text, MAX_TEXT) ?? "";
      let imageUrl = typeof src.imageUrl === "string" && src.imageUrl.trim() ? src.imageUrl.trim() : null;
      if (imageUrl && !/^(https?:|data:image\/)/i.test(imageUrl)) imageUrl = null;
      // Photos come from the dashboard as data URIs when the upload endpoint
      // was unreachable — push them to storage so the JSON stays small.
      imageUrl = (await rehostImageIfInline(this.storage, imageUrl, `build-guides/${tenantId}`)) ?? null;
      const tags = (v: unknown, max: number) =>
        Array.isArray(v)
          ? ([...new Set(v.map((t) => clip(t, MAX_SHORT)).filter(Boolean))] as string[]).slice(0, max)
          : [];
      const tools = tags(src.tools, 8);
      const onlyWith = tags(src.onlyWith, 20);
      const skipWith = tags(src.skipWith, 20);
      if (!text && !imageUrl) continue; // an empty card is not a step
      out.push({
        id: typeof src.id === "string" && src.id ? src.id.slice(0, 64) : randomUUID(),
        text,
        imageUrl,
        amount: clip(src.amount, MAX_SHORT),
        tools,
        ...(onlyWith.length ? { onlyWith } : {}),
        ...(skipWith.length ? { skipWith } : {}),
      });
    }
    return out;
  }

  private toDto(row: any): BuildGuideDto {
    return {
      id: row.id,
      brandId: row.brandId,
      name: row.name,
      nameKey: row.nameKey,
      steps: Array.isArray(row.steps) ? row.steps : [],
      packNote: row.packNote ?? null,
      updatedAt: row.updatedAt instanceof Date ? row.updatedAt.toISOString() : String(row.updatedAt),
    };
  }
}
