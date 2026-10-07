import { Injectable, NotFoundException } from "@nestjs/common";
import { buildGuideNameKey } from "@orderhub/shared";
import { PrismaService } from "../../infrastructure/database/prisma.service";

/**
 * Training mode: staff walk a guide step by step and mark it learned. A
 * completion older than the guide's last edit counts as "needs a refresher".
 */
@Injectable()
export class BuildGuideTrainingService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Every guide with the caller's own status and team counts, tagged with the
   * brands the product is really SOLD under. A guide is keyed to the product's
   * own brandId, which is often the location's placeholder brand ("Order Hub"),
   * so that is useless for "which training belongs to which brand". The real
   * brands come from where the product sits: menu → channel assignments (the
   * brand a menu is served as at a location), the item's own brandIds, then
   * the menu's brand. With `locationId`, only guides for products sold at that
   * location are returned, with that location's brands.
   */
  async overview(tenantId: string, userId: string, locationId?: string | null) {
    const guides = await this.prisma.buildGuide.findMany({
      where: { tenantId },
      orderBy: [{ brandId: "asc" }, { name: "asc" }],
      include: {
        brand: { select: { name: true } },
        trainings: { select: { userId: true, completedAt: true } },
      },
    });
    if (guides.length === 0) return [];

    const items: any[] = await this.prisma.menuItem.findMany({
      where: { brandId: { in: [...new Set(guides.map((g: any) => g.brandId))] as string[] } },
      select: {
        brandId: true,
        name: true,
        imageUrl: true,
        brandIds: true,
        locationId: true,
        categories: {
          select: {
            category: {
              select: {
                menu: {
                  select: {
                    brandId: true,
                    locationId: true,
                    deletedAt: true,
                    assignments: { select: { locationId: true, brandId: true } },
                  },
                },
              },
            },
          },
        },
      },
    });

    // Where each product is sold: [locationId | null, brandIds[]] pairs.
    type Placement = { locationId: string | null; brandIds: string[] };
    const byKey = new Map<string, { photo: string | null; placements: Placement[] }>();
    for (const i of items) {
      const k = `${i.brandId}|${buildGuideNameKey(i.name)}`;
      const entry = byKey.get(k) ?? { photo: null, placements: [] };
      if (!entry.photo && i.imageUrl) entry.photo = i.imageUrl;
      for (const link of i.categories ?? []) {
        const menu = link?.category?.menu;
        if (!menu || menu.deletedAt) continue;
        if (menu.assignments?.length) {
          for (const a of menu.assignments) entry.placements.push({ locationId: a.locationId, brandIds: [a.brandId] });
        } else {
          entry.placements.push({
            locationId: menu.locationId ?? null,
            brandIds: i.brandIds?.length ? i.brandIds : [menu.brandId],
          });
        }
      }
      if (i.brandIds?.length) entry.placements.push({ locationId: i.locationId ?? null, brandIds: i.brandIds });
      byKey.set(k, entry);
    }

    const rows: any[] = [];
    const brandIdsNeeded = new Set<string>();
    for (const g of guides as any[]) {
      const entry = byKey.get(`${g.brandId}|${g.nameKey}`);
      const placements = (entry?.placements ?? []).filter((p) => !locationId || p.locationId === locationId);
      if (locationId && placements.length === 0) continue; // not sold at this location
      const brands = [...new Set(placements.flatMap((p) => p.brandIds))];
      if (brands.length === 0) brands.push(g.brandId);
      brands.forEach((b) => brandIdsNeeded.add(b));
      rows.push({ g, brands, photo: entry?.photo ?? null });
    }

    const brandRows = await this.prisma.brand.findMany({
      where: { id: { in: [...brandIdsNeeded] }, tenantId },
      select: { id: true, name: true },
    });
    const brandName = new Map<string, string>(brandRows.map((b: any) => [b.id, b.name]));

    return rows.map(({ g, brands, photo }) => {
      const updated = new Date(g.updatedAt).getTime();
      const mine = g.trainings.find((t: any) => t.userId === userId);
      const current = g.trainings.filter((t: any) => new Date(t.completedAt).getTime() >= updated);
      const steps = Array.isArray(g.steps) ? g.steps : [];
      const named = brands
        .filter((b: string) => brandName.has(b))
        .map((b: string) => ({ id: b, name: brandName.get(b)! }))
        .sort((a: any, b: any) => a.name.localeCompare(b.name));
      return {
        id: g.id,
        name: g.name,
        brandName: named[0]?.name ?? g.brand?.name ?? null,
        brands: named,
        stepCount: steps.length,
        imageUrl: photo ?? steps.find((s: any) => s?.imageUrl)?.imageUrl ?? null,
        updatedAt: g.updatedAt,
        hasVideo: !!g.videoUrl,
        myStatus: !mine ? "new" : new Date(mine.completedAt).getTime() >= updated ? "trained" : "refresher",
        trainedCount: current.length,
      };
    });
  }

  async getGuide(guideId: string, tenantId: string) {
    const g = await this.prisma.buildGuide.findFirst({
      where: { id: guideId, tenantId },
      include: { brand: { select: { name: true } } },
    });
    if (!g) throw new NotFoundException("Guide not found");
    return {
      id: g.id,
      brandId: g.brandId,
      brandName: (g as any).brand?.name ?? null,
      name: g.name,
      nameKey: g.nameKey,
      steps: Array.isArray(g.steps) ? g.steps : [],
      packNote: g.packNote ?? null,
      videoUrl: (g as any).videoUrl ?? null,
      updatedAt: g.updatedAt,
    };
  }

  async complete(guideId: string, tenantId: string, userId: string) {
    await this.getGuide(guideId, tenantId);
    const now = new Date();
    await this.prisma.buildGuideTraining.upsert({
      where: { guideId_userId: { guideId, userId } },
      create: { tenantId, guideId, userId, completedAt: now },
      update: { completedAt: now },
    });
    return { ok: true, completedAt: now };
  }

  /** Who has learned this guide — for managers. */
  async whoTrained(guideId: string, tenantId: string) {
    const g = await this.getGuide(guideId, tenantId);
    const rows = await this.prisma.buildGuideTraining.findMany({
      where: { guideId },
      orderBy: { completedAt: "desc" },
    });
    const users = rows.length
      ? await this.prisma.user.findMany({
          where: { id: { in: rows.map((r: any) => r.userId) }, tenantId },
          select: { id: true, firstName: true, lastName: true },
        })
      : [];
    const byId = new Map(users.map((u: any) => [u.id, `${u.firstName} ${u.lastName}`.trim()]));
    const updated = new Date(g.updatedAt).getTime();
    return rows
      .filter((r: any) => byId.has(r.userId))
      .map((r: any) => ({
        name: byId.get(r.userId),
        completedAt: r.completedAt,
        current: new Date(r.completedAt).getTime() >= updated,
      }));
  }
}
