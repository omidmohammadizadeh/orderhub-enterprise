import { BadRequestException, Injectable, NotFoundException, Optional } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import {
  BUILD_GUIDE_MAX_STEPS,
  buildGuideNameKey,
  matchBuildGuideKey,
  type BuildGuideDto,
  type BuildGuideStep,
} from "@orderhub/shared";
import { PrismaService } from "../../infrastructure/database/prisma.service";
import { SupabaseStorageService } from "../uploads/supabase-storage.service";
import { rehostImageIfInline } from "../uploads/rehost-image";

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
    if (keys.length === 0) {
      return { orderId: order.id, lines: order.items.map((l: any) => ({ ...this.line(l), guide: null })) };
    }

    const menuItemIds = order.items.map((l: any) => l.menuItemId).filter(Boolean) as string[];
    const products = menuItemIds.length
      ? await this.prisma.menuItem.findMany({
          where: { id: { in: menuItemIds } },
          select: { id: true, brandId: true, name: true },
        })
      : [];
    const productById = new Map<string, { brandId: string; name: string }>(
      products.map((p: any) => [p.id, p]),
    );

    const keysByBrand = new Map<string, Set<string>>();
    const allKeys = new Set<string>();
    for (const k of keys) {
      allKeys.add(k.nameKey);
      if (!keysByBrand.has(k.brandId)) keysByBrand.set(k.brandId, new Set());
      keysByBrand.get(k.brandId)!.add(k.nameKey);
    }

    const picks: Array<{ brandId: string | null; nameKey: string } | null> = order.items.map((l: any) => {
      const product = l.menuItemId ? productById.get(l.menuItemId) : undefined;
      const names = [product?.name, l.name].filter(Boolean) as string[];
      const brands = [product?.brandId, order.brandId].filter(Boolean) as string[];
      for (const brandId of brands) {
        for (const n of names) {
          const k = matchBuildGuideKey(n, keysByBrand.get(brandId) ?? []);
          if (k) return { brandId, nameKey: k };
        }
      }
      for (const n of names) {
        const k = matchBuildGuideKey(n, allKeys);
        if (k) return { brandId: null, nameKey: k };
      }
      return null;
    });

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
      const tools = Array.isArray(src.tools)
        ? (src.tools.map((t) => clip(t, MAX_SHORT)).filter(Boolean) as string[]).slice(0, 8)
        : [];
      if (!text && !imageUrl) continue; // an empty card is not a step
      out.push({
        id: typeof src.id === "string" && src.id ? src.id.slice(0, 64) : randomUUID(),
        text,
        imageUrl,
        amount: clip(src.amount, MAX_SHORT),
        tools,
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
