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

  /** Every guide in the tenant, with the caller's own status and team counts. */
  async overview(tenantId: string, userId: string) {
    const guides = await this.prisma.buildGuide.findMany({
      where: { tenantId },
      orderBy: [{ brandId: "asc" }, { name: "asc" }],
      include: {
        brand: { select: { name: true } },
        trainings: { select: { userId: true, completedAt: true } },
      },
    });
    if (guides.length === 0) return [];

    // A product photo for each card, matched the same way guides are (brand + name).
    const items = await this.prisma.menuItem.findMany({
      where: { brandId: { in: [...new Set(guides.map((g: any) => g.brandId))] as string[] }, imageUrl: { not: null } },
      select: { brandId: true, name: true, imageUrl: true },
    });
    const photo = new Map<string, string>();
    for (const i of items as any[]) {
      const k = `${i.brandId}|${buildGuideNameKey(i.name)}`;
      if (!photo.has(k) && i.imageUrl) photo.set(k, i.imageUrl);
    }

    return guides.map((g: any) => {
      const updated = new Date(g.updatedAt).getTime();
      const mine = g.trainings.find((t: any) => t.userId === userId);
      const current = g.trainings.filter((t: any) => new Date(t.completedAt).getTime() >= updated);
      const steps = Array.isArray(g.steps) ? g.steps : [];
      return {
        id: g.id,
        name: g.name,
        brandName: g.brand?.name ?? null,
        stepCount: steps.length,
        imageUrl: photo.get(`${g.brandId}|${g.nameKey}`) ?? steps.find((s: any) => s?.imageUrl)?.imageUrl ?? null,
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
