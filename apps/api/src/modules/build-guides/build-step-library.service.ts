import { BadRequestException, Injectable, NotFoundException, Optional } from "@nestjs/common";
import { PrismaService } from "../../infrastructure/database/prisma.service";
import { SupabaseStorageService } from "../uploads/supabase-storage.service";
import { rehostImageIfInline } from "../uploads/rehost-image";

function clip(v: unknown, max: number): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t ? t.slice(0, max) : null;
}

/**
 * Reusable "How to build" steps. Inserting one into a guide copies it (the
 * editor does that client-side), so the library can be edited or pruned
 * without changing any guide a kitchen already learned.
 */
@Injectable()
export class BuildStepLibraryService {
  constructor(
    private readonly prisma: PrismaService,
    @Optional() private readonly storage?: SupabaseStorageService,
  ) {}

  list(tenantId: string, search?: string) {
    const q = search?.trim();
    return this.prisma.buildStepTemplate.findMany({
      where: {
        tenantId,
        ...(q && {
          OR: [
            { title: { contains: q, mode: "insensitive" } },
            { text: { contains: q, mode: "insensitive" } },
          ],
        }),
      },
      orderBy: { updatedAt: "desc" },
      take: 200,
    });
  }

  async create(tenantId: string, body: Record<string, unknown>, userId?: string) {
    const text = clip(body.text, 1000);
    let imageUrl = clip(body.imageUrl, 4_000_000);
    if (!text && !imageUrl) throw new BadRequestException("A library step needs an instruction or a photo");
    if (imageUrl && !/^(https?:|data:image\/|\/api\/v1\/)/i.test(imageUrl)) imageUrl = null;
    imageUrl = (await rehostImageIfInline(this.storage, imageUrl, `build-guides/${tenantId}`)) ?? null;

    let brandId = clip(body.brandId, 64);
    if (brandId) {
      const brand = await this.prisma.brand.findFirst({ where: { id: brandId, tenantId }, select: { id: true } });
      if (!brand) brandId = null;
    }
    const tools = Array.isArray(body.tools)
      ? ([...new Set(body.tools.map((t) => clip(t, 80)).filter(Boolean))] as string[]).slice(0, 8)
      : [];
    return this.prisma.buildStepTemplate.create({
      data: {
        tenantId,
        brandId,
        title: clip(body.title, 80) ?? (text ?? "Photo step").slice(0, 60),
        text: text ?? "",
        imageUrl,
        amount: clip(body.amount, 80),
        tools,
        createdBy: userId ?? null,
      },
    });
  }

  async remove(id: string, tenantId: string) {
    const res = await this.prisma.buildStepTemplate.deleteMany({ where: { id, tenantId } });
    if (res.count === 0) throw new NotFoundException("Library step not found");
    return { ok: true };
  }
}
