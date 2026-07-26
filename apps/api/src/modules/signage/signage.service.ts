import { Injectable, NotFoundException, BadRequestException } from "@nestjs/common";
import { randomBytes } from "crypto";
import { PrismaService } from "../../infrastructure/database/prisma.service";
import { MenusService } from "../menus/menus.service";

// Digital Signage — in-store menu boards on TV screens.
//
// A SignageDisplay is a saved screen config: a location, an ordered subset of
// that location's POS menu categories, an orientation, and display options. It
// stores NO prices or availability — the public render endpoint resolves those
// live from the POS menu (MenusService.findActiveMenuForLocation), so a board
// always matches the till (same prices, and 86'd items disappear automatically).
//
// The TV opens /signage/<publicToken> with no login; publicToken is random and
// unguessable. All operator-facing methods are tenant-scoped (tenantId comes
// from the verified JWT, never the request body).

export interface SignageConfig {
  columns?: number; // grid columns in landscape (portrait is always 1)
  showImages?: boolean; // show item photos (default off — cleaner board)
  showLogo?: boolean; // show the location/brand logo in the header
  pageRotationSeconds?: number; // if categories overflow, seconds per page
  refreshSeconds?: number; // how often the TV refetches (default 45)
  theme?: string; // "dark" | "light"
}

interface UpsertDisplayInput {
  locationId: string;
  brandId?: string | null;
  name: string;
  categoryIds?: string[];
  orientation?: "landscape" | "portrait";
  config?: SignageConfig;
  isActive?: boolean;
}

@Injectable()
export class SignageService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly menus: MenusService,
  ) {}

  // A location belongs to the tenant only via its brand — mirror the check
  // used in MenusService.findActiveMenuForLocation.
  private async assertLocation(tenantId: string, locationId: string) {
    const loc = await this.prisma.location.findFirst({
      where: { id: locationId, brand: { tenantId } },
      select: { id: true, brandId: true },
    });
    if (!loc) throw new NotFoundException("Location not found");
    return loc;
  }

  async list(tenantId: string, locationId?: string) {
    return this.prisma.signageDisplay.findMany({
      where: { tenantId, ...(locationId ? { locationId } : {}) },
      orderBy: { createdAt: "asc" },
    });
  }

  async create(tenantId: string, input: UpsertDisplayInput) {
    if (!input.name?.trim()) throw new BadRequestException("Name is required");
    const loc = await this.assertLocation(tenantId, input.locationId);
    return this.prisma.signageDisplay.create({
      data: {
        tenantId,
        locationId: input.locationId,
        brandId: input.brandId ?? loc.brandId ?? null,
        name: input.name.trim(),
        publicToken: this.newToken(),
        categoryIds: input.categoryIds ?? [],
        orientation: input.orientation ?? "landscape",
        config: (input.config ?? {}) as any,
        isActive: input.isActive ?? true,
      },
    });
  }

  async update(
    tenantId: string,
    id: string,
    input: Partial<UpsertDisplayInput>,
  ) {
    // Scope the write to the tenant — updateMany avoids leaking cross-tenant ids.
    const existing = await this.prisma.signageDisplay.findFirst({
      where: { id, tenantId },
      select: { id: true },
    });
    if (!existing) throw new NotFoundException("Display not found");
    return this.prisma.signageDisplay.update({
      where: { id },
      data: {
        ...(input.name !== undefined ? { name: input.name.trim() } : {}),
        ...(input.categoryIds !== undefined
          ? { categoryIds: input.categoryIds }
          : {}),
        ...(input.orientation !== undefined
          ? { orientation: input.orientation }
          : {}),
        ...(input.config !== undefined ? { config: input.config as any } : {}),
        ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
      },
    });
  }

  async remove(tenantId: string, id: string) {
    const existing = await this.prisma.signageDisplay.findFirst({
      where: { id, tenantId },
      select: { id: true },
    });
    if (!existing) throw new NotFoundException("Display not found");
    await this.prisma.signageDisplay.delete({ where: { id } });
    return { ok: true };
  }

  // ── Public TV render (no auth) ────────────────────────────────────────────
  // Resolves the location's live POS menu and projects only the chosen
  // categories, in the chosen order, into a slim board payload. Prices + 86
  // come straight from the POS menu, so the board can never drift from the till.
  async renderPublic(token: string) {
    const display = await this.prisma.signageDisplay.findFirst({
      where: { publicToken: token, isActive: true },
    });
    if (!display) throw new NotFoundException("Display not found");

    const [menu, location] = await Promise.all([
      this.menus.findActiveMenuForLocation(display.locationId, display.tenantId),
      this.prisma.location.findUnique({
        where: { id: display.locationId },
        select: { name: true },
      }),
    ]);

    const byId = new Map<string, any>();
    for (const cat of (menu as any)?.categories ?? []) byId.set(cat.id, cat);

    const categories: Array<{
      id: string;
      name: string;
      items: Array<{
        name: string;
        description?: string | null;
        imageUrl?: string | null;
        price?: number | null;
        sizes?: Array<{ name: string; price: number }>;
      }>;
    }> = [];

    // Preserve the operator's chosen order.
    for (const catId of display.categoryIds) {
      const cat = byId.get(catId);
      if (!cat) continue;
      const items = ((cat.items ?? []) as any[])
        // A menu board is customer-facing: drop items hidden from customers
        // (POS itself still shows them). 86'd items are already stripped by
        // findActiveMenuForLocation.
        .filter(
          (link) =>
            link?.item &&
            link.isVisible !== false &&
            link.item.visibleToCustomers !== false,
        )
        .map((link) => this.projectItem(link));
      if (items.length) categories.push({ id: cat.id, name: cat.name, items });
    }

    return {
      display: {
        name: display.name,
        orientation: display.orientation,
        config: (display.config ?? {}) as SignageConfig,
      },
      location: {
        name: location?.name ?? "",
        logoUrl: (menu as any)?.logoImage ?? null,
      },
      categories,
    };
  }

  private projectItem(link: any) {
    const item = link.item;
    const base = {
      name: item.name as string,
      description: (item.description as string | null) ?? null,
      imageUrl: (item.imageUrl as string | null) ?? null,
    };
    // Multi-size items (e.g. 10"/12" pizza) show a price per size; the POS
    // stores them in productSkus JSON.
    const skus = Array.isArray(item.productSkus) ? item.productSkus : [];
    if (item.hasMultipleSkus && skus.length) {
      return {
        ...base,
        sizes: skus
          .filter((s: any) => s && s.name != null)
          .map((s: any) => ({ name: String(s.name), price: Number(s.price ?? 0) })),
      };
    }
    // Single price — a per-category override wins over the item base price.
    const price =
      link.priceOverride != null
        ? Number(link.priceOverride)
        : Number(item.basePrice ?? 0);
    return { ...base, price };
  }

  private newToken(): string {
    // 24 URL-safe bytes → unguessable public id for the TV URL.
    return randomBytes(18).toString("base64url");
  }
}
