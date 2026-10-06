import { BadRequestException, Injectable, NotFoundException, Optional } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import {
  ASSEMBLY_LAYER_KINDS,
  ASSEMBLY_MAX_LAYERS,
  buildGuideNameKey,
  type AssemblyChartDto,
  type AssemblyLayer,
  type AssemblyLayerKind,
} from "@orderhub/shared";
import { PrismaService } from "../../infrastructure/database/prisma.service";
import { SupabaseStorageService } from "../uploads/supabase-storage.service";
import { rehostImageIfInline } from "../uploads/rehost-image";
import { pickKeysForOrderLines } from "./name-key-match";

function clip(v: unknown, max: number): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t ? t.slice(0, max) : null;
}

const KINDS = new Set<string>(ASSEMBLY_LAYER_KINDS);

/**
 * Assembly charts — the poster-style layer stack per product. Same keying and
 * lookup rules as BuildGuidesService (brand + product name).
 */
@Injectable()
export class AssemblyChartsService {
  constructor(
    private readonly prisma: PrismaService,
    @Optional() private readonly storage?: SupabaseStorageService,
  ) {}

  async getForItem(itemId: string, tenantId: string) {
    const item = await this.assertItem(itemId, tenantId);
    const row = await this.prisma.assemblyChart.findUnique({
      where: { brandId_nameKey: { brandId: item.brandId, nameKey: buildGuideNameKey(item.name) } },
    });
    return { chart: row ? this.toDto(row) : null, productImageUrl: item.imageUrl ?? null };
  }

  /** Save or (with no layers) remove a product's chart. */
  async saveForItem(itemId: string, tenantId: string, body: Record<string, unknown>, userId?: string) {
    const item = await this.assertItem(itemId, tenantId);
    const nameKey = buildGuideNameKey(item.name);
    if (!nameKey) throw new BadRequestException("This product has no name to attach a chart to");
    const layers = await this.cleanLayers(body.layers, tenantId);

    if (layers.length === 0) {
      await this.prisma.assemblyChart.deleteMany({ where: { brandId: item.brandId, nameKey } });
      return null;
    }
    const heroRaw = clip(body.heroImageUrl, 4_000_000);
    const heroImageUrl =
      heroRaw && /^(https?:|data:image\/)/i.test(heroRaw)
        ? ((await rehostImageIfInline(this.storage, heroRaw, `assembly-charts/${tenantId}`)) ?? null)
        : null;
    const data = {
      name: item.name,
      title: clip(body.title, 60) ?? item.name,
      altTitle: clip(body.altTitle, 60),
      heroImageUrl,
      layers: layers as any,
      footNote: clip(body.footNote, 120),
      updatedBy: userId ?? null,
    };
    const row = await this.prisma.assemblyChart.upsert({
      where: { brandId_nameKey: { brandId: item.brandId, nameKey } },
      create: { tenantId, brandId: item.brandId, nameKey, ...data },
      update: data,
    });
    return this.toDto(row);
  }

  listKeys(tenantId: string) {
    return this.prisma.assemblyChart.findMany({ where: { tenantId }, select: { brandId: true, nameKey: true } });
  }

  /** Every chart in the tenant — the editor's "copy layers from…" list. */
  async list(tenantId: string) {
    const rows = await this.prisma.assemblyChart.findMany({
      where: { tenantId },
      orderBy: { title: "asc" },
      include: { brand: { select: { name: true } } },
    });
    return rows.map((r: any) => ({ ...this.toDto(r), brandName: r.brand?.name ?? null }));
  }

  /** Charts for each line of an order — the "Chart" pop-up. */
  async forOrder(orderId: string, tenantId: string) {
    const order = await this.prisma.order.findFirst({
      where: { id: orderId, tenantId },
      select: {
        id: true,
        brandId: true,
        items: { select: { id: true, name: true, quantity: true, modifiers: true, notes: true, menuItemId: true } },
      },
    });
    if (!order) throw new NotFoundException("Order not found");
    const picks = await pickKeysForOrderLines(this.prisma, order as any, await this.listKeys(tenantId));
    const wanted = picks.filter(Boolean) as Array<{ brandId: string | null; nameKey: string }>;
    const rows = wanted.length
      ? await this.prisma.assemblyChart.findMany({
          where: { tenantId, nameKey: { in: [...new Set(wanted.map((w) => w.nameKey))] } },
          orderBy: { updatedAt: "desc" },
        })
      : [];
    const images = await this.productImages(rows);
    return {
      orderId: order.id,
      lines: order.items.map((l: any, i: number) => {
        const pick = picks[i];
        const row = pick
          ? rows.find((r: any) => r.nameKey === pick.nameKey && (!pick.brandId || r.brandId === pick.brandId))
          : undefined;
        return {
          orderItemId: l.id,
          name: l.name,
          quantity: l.quantity,
          modifiers: Array.isArray(l.modifiers) ? l.modifiers : [],
          notes: l.notes ?? null,
          chart: row ? this.toDto(row, images) : null,
        };
      }),
    };
  }

  /** Every charted product on a menu, in menu order — the printable board. */
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
      ? await this.prisma.assemblyChart.findMany({ where: { tenantId, brandId: { in: brandIds } } })
      : [];
    const byKey = new Map<string, any>(rows.map((r: any) => [`${r.brandId}|${r.nameKey}`, r]));
    const seen = new Set<string>();
    const charts: AssemblyChartDto[] = [];
    for (const i of items as any[]) {
      const row = byKey.get(`${i.brandId}|${buildGuideNameKey(i.name)}`);
      if (!row || seen.has(row.id)) continue;
      seen.add(row.id);
      charts.push(this.toDto(row, new Map([[row.id, i.imageUrl ?? null]])));
    }
    return { menuName: menu.name, brandName: menu.brand?.name ?? null, charts };
  }

  // ── helpers ────────────────────────────────────────────────────────────────

  private async productImages(rows: any[]) {
    const out = new Map<string, string | null>();
    const need = rows.filter((r) => !r.heroImageUrl);
    if (!need.length) return out;
    const items = await this.prisma.menuItem.findMany({
      where: { brandId: { in: [...new Set(need.map((r) => r.brandId))] }, imageUrl: { not: null } },
      select: { brandId: true, name: true, imageUrl: true },
    });
    for (const r of need) {
      const hit = (items as any[]).find((i) => i.brandId === r.brandId && buildGuideNameKey(i.name) === r.nameKey);
      out.set(r.id, hit?.imageUrl ?? null);
    }
    return out;
  }

  private async assertItem(itemId: string, tenantId: string) {
    const item = await this.prisma.menuItem.findUnique({
      where: { id: itemId },
      select: { id: true, brandId: true, name: true, imageUrl: true },
    });
    if (!item) throw new NotFoundException("Menu item not found");
    const brand = await this.prisma.brand.findFirst({ where: { id: item.brandId, tenantId }, select: { id: true } });
    if (!brand) throw new NotFoundException("Menu item not found");
    return item;
  }

  private async cleanLayers(raw: unknown, tenantId: string): Promise<AssemblyLayer[]> {
    if (raw == null) return [];
    if (!Array.isArray(raw)) throw new BadRequestException("layers must be a list");
    if (raw.length > ASSEMBLY_MAX_LAYERS) {
      throw new BadRequestException(`A chart can have at most ${ASSEMBLY_MAX_LAYERS} layers`);
    }
    const out: AssemblyLayer[] = [];
    for (const l of raw) {
      if (!l || typeof l !== "object") continue;
      const src = l as Record<string, unknown>;
      const kind = (typeof src.kind === "string" && KINDS.has(src.kind) ? src.kind : "custom") as AssemblyLayerKind;
      let imageUrl = clip(src.imageUrl, 4_000_000);
      if (imageUrl && !/^(https?:|data:image\/)/i.test(imageUrl)) imageUrl = null;
      imageUrl = (await rehostImageIfInline(this.storage, imageUrl, `assembly-charts/${tenantId}`)) ?? null;
      const label = clip(src.label, 80) ?? "";
      if (kind === "custom" && !imageUrl && !label) continue; // nothing to draw
      const color = typeof src.color === "string" && /^#[0-9a-f]{6}$/i.test(src.color) ? src.color : null;
      out.push({
        id: typeof src.id === "string" && src.id ? src.id.slice(0, 64) : randomUUID(),
        kind,
        label,
        ...(color ? { color } : {}),
        ...(imageUrl ? { imageUrl } : {}),
        ...(clip(src.callout, 80) ? { callout: clip(src.callout, 80) } : {}),
      });
    }
    return out;
  }

  private toDto(row: any, images?: Map<string, string | null>): AssemblyChartDto {
    return {
      id: row.id,
      brandId: row.brandId,
      name: row.name,
      nameKey: row.nameKey,
      title: row.title,
      altTitle: row.altTitle ?? null,
      heroImageUrl: row.heroImageUrl ?? images?.get(row.id) ?? null,
      layers: Array.isArray(row.layers) ? row.layers : [],
      footNote: row.footNote ?? null,
      updatedAt: row.updatedAt instanceof Date ? row.updatedAt.toISOString() : String(row.updatedAt),
    };
  }
}
