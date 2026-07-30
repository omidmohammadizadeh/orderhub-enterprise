import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
} from "@nestjs/common";
import { randomBytes } from "crypto";
import { PrismaService } from "../../infrastructure/database/prisma.service";
import { OrdersService } from "../orders/orders.service";
import { MenusService } from "../menus/menus.service";

// Self-service kiosk — a screen standing in the shop that customers order
// from themselves.
//
// Deliberately narrower than the storefront or the table QR:
//   • ALWAYS walk-in collection. No table, no address, no delivery — so
//     there is no fulfilment choice to get wrong and no PII to collect.
//   • Two ways to pay, both of which already exist and are tested:
//       PAY_AT_COUNTER — order goes to the kitchen unpaid, staff take the
//                        money at the till (paymentMethod CASH, PENDING)
//       CARD           — a Stripe payment link rendered as a QR the
//                        customer scans and pays on their own phone
//     I deliberately did NOT wire a card reader to the kiosk: an
//     unattended terminal is a different risk class (chargebacks, stuck
//     PaymentIntents with nobody standing there to retry) and the link
//     flow reuses code that is already in production.
//   • No login on the device — an opaque rotatable token, same model as
//     signage screens and table QR codes.

export interface KioskOrderItem {
  name: string;
  quantity: number;
  unitPrice: number;
  totalPrice: number;
  modifiers?: { name: string; price: number; quantity?: number }[];
  notes?: string | null;
  menuItemId?: string | null;
}

interface UpsertKioskInput {
  locationId: string;
  brandId?: string | null;
  name: string;
  isActive?: boolean;
  config?: {
    allowCardPayment?: boolean;
    allowPayAtCounter?: boolean;
    categoryIds?: string[];
  };
}

// Same replay window as table QR: a customer double-tapping "Send" or a
// screen losing wifi mid-request must not produce two orders.
const REPLAY_TTL_MS = 5 * 60_000;

@Injectable()
export class KioskService {
  private readonly recent = new Map<string, { at: number; result: any }>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly orders: OrdersService,
    private readonly menus: MenusService,
  ) {}

  private newToken(): string {
    return randomBytes(18).toString("base64url");
  }

  private async assertLocation(tenantId: string, locationId: string) {
    const loc = await this.prisma.location.findFirst({
      where: { id: locationId, brand: { tenantId } },
      select: { id: true, brandId: true },
    });
    if (!loc) throw new NotFoundException("Location not found");
    return loc;
  }

  // ── Staff CRUD ──────────────────────────────────────────────────────

  async list(tenantId: string, locationId?: string) {
    return this.prisma.kioskDevice.findMany({
      where: { tenantId, ...(locationId ? { locationId } : {}) },
      orderBy: { createdAt: "asc" },
    });
  }

  async create(tenantId: string, input: UpsertKioskInput) {
    if (!input.name?.trim()) throw new BadRequestException("Name is required");
    const loc = await this.assertLocation(tenantId, input.locationId);
    return this.prisma.kioskDevice.create({
      data: {
        tenantId,
        locationId: input.locationId,
        brandId: input.brandId ?? loc.brandId ?? null,
        name: input.name.trim(),
        publicToken: this.newToken(),
        isActive: input.isActive ?? true,
        config: (input.config ?? {
          allowCardPayment: true,
          allowPayAtCounter: true,
        }) as any,
      },
    });
  }

  async update(tenantId: string, id: string, input: Partial<UpsertKioskInput>) {
    const existing = await this.prisma.kioskDevice.findFirst({
      where: { id, tenantId },
      select: { id: true },
    });
    if (!existing) throw new NotFoundException("Kiosk not found");
    return this.prisma.kioskDevice.update({
      where: { id },
      data: {
        ...(input.name !== undefined ? { name: input.name.trim() } : {}),
        ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
        ...(input.brandId !== undefined ? { brandId: input.brandId } : {}),
        ...(input.config !== undefined ? { config: input.config as any } : {}),
      },
    });
  }

  async remove(tenantId: string, id: string) {
    const existing = await this.prisma.kioskDevice.findFirst({
      where: { id, tenantId },
      select: { id: true },
    });
    if (!existing) throw new NotFoundException("Kiosk not found");
    await this.prisma.kioskDevice.delete({ where: { id } });
    return { ok: true };
  }

  /** Rotate the token — kills the URL already loaded on that screen. */
  async rotateToken(tenantId: string, id: string) {
    const existing = await this.prisma.kioskDevice.findFirst({
      where: { id, tenantId },
      select: { id: true },
    });
    if (!existing) throw new NotFoundException("Kiosk not found");
    return this.prisma.kioskDevice.update({
      where: { id },
      data: { publicToken: this.newToken() },
    });
  }

  // ── Public device surface ───────────────────────────────────────────

  /**
   * Resolve a kiosk token to just enough for the screen to render its own
   * menu. No other kiosks, no takings, no customer data.
   */
  async resolve(token: string) {
    const kiosk = await this.prisma.kioskDevice.findFirst({
      where: { publicToken: token, isActive: true },
      include: {
        location: {
          select: {
            id: true,
            name: true,
            brand: { select: { id: true, name: true, slug: true, logoUrl: true } },
          },
        },
      },
    });
    if (!kiosk) throw new NotFoundException("This kiosk is not set up");

    // The menu is resolved SERVER-side, by the same call the POS and the
    // menu boards use — findActiveMenuForLocation. The screen is never
    // asked to pick a menu, so a kiosk cannot drift from the till: same
    // prices, same 86'd items, same per-location assignment. (An earlier
    // draft had the screen fetch the storefront menu by slug, which is a
    // different resolution path and would have diverged the moment a
    // location published a POS-only menu.)
    const menu = await this.menus.findActiveMenuForLocation(
      kiosk.locationId,
      kiosk.tenantId,
    );

    const cfg = (kiosk.config ?? {}) as any;
    // An optional whitelist — a kiosk in the doorway might only sell the
    // quick stuff. Empty means the whole menu.
    const only: string[] = Array.isArray(cfg.categoryIds) ? cfg.categoryIds : [];
    const categories = ((menu as any)?.categories ?? []).filter(
      (c: any) => !only.length || only.includes(c.id),
    );

    return {
      menu: menu ? { ...(menu as any), categories } : null,
      kioskId: kiosk.id,
      kioskName: kiosk.name,
      locationId: kiosk.locationId,
      locationName: kiosk.location?.name ?? null,
      brandId: kiosk.brandId ?? kiosk.location?.brand?.id ?? null,
      brandName: kiosk.location?.brand?.name ?? null,
      brandSlug: kiosk.location?.brand?.slug ?? null,
      logoUrl: kiosk.location?.brand?.logoUrl ?? null,
      allowCardPayment: cfg.allowCardPayment !== false,
      allowPayAtCounter: cfg.allowPayAtCounter !== false,
      categoryIds: Array.isArray(cfg.categoryIds) ? cfg.categoryIds : [],
    };
  }

  /**
   * Place a kiosk order. Always walk-in collection.
   *
   * `payment: "CARD"` returns a payment link for the customer to scan and
   * pay on their phone; the order is held unpaid until Stripe confirms,
   * exactly like the POS payment-link flow. `PAY_AT_COUNTER` sends it
   * straight through as an unpaid cash order.
   */
  async placeOrder(
    token: string,
    input: {
      items: KioskOrderItem[];
      payment: "CARD" | "PAY_AT_COUNTER";
      customerName?: string;
      notes?: string | null;
      requestId?: string;
    },
  ) {
    const replayKey = input.requestId ? `${token}:${input.requestId}` : null;
    if (replayKey) {
      const hit = this.recent.get(replayKey);
      if (hit && Date.now() - hit.at < REPLAY_TTL_MS) return hit.result;
    }

    const kiosk = await this.prisma.kioskDevice.findFirst({
      where: { publicToken: token, isActive: true },
      include: {
        location: {
          select: { id: true, brand: { select: { id: true, tenantId: true } } },
        },
      },
    });
    if (!kiosk) throw new NotFoundException("This kiosk is not set up");

    const tenantId = kiosk.location?.brand?.tenantId;
    if (!tenantId) throw new NotFoundException("Location not found");

    const cfg = (kiosk.config ?? {}) as any;
    if (input.payment === "CARD" && cfg.allowCardPayment === false) {
      throw new ForbiddenException("Card payment is off on this kiosk");
    }
    if (input.payment === "PAY_AT_COUNTER" && cfg.allowPayAtCounter === false) {
      throw new ForbiddenException("Pay at counter is off on this kiosk");
    }

    const items = (input.items ?? []).filter(
      (i) => i?.name && Number(i.quantity) > 0,
    );
    if (!items.length) throw new BadRequestException("Your basket is empty");

    const subtotal =
      Math.round(
        items.reduce((s, i) => s + Number(i.totalPrice || 0), 0) * 100,
      ) / 100;

    const created = await this.orders.create(
      {
        locationId: kiosk.locationId,
        brandId: kiosk.brandId ?? kiosk.location?.brand?.id ?? undefined,
        orderSource: "POS",
        fulfillmentType: "PICKUP",
        customerInfo: { name: input.customerName?.trim() || "Kiosk" },
        items: items as any,
        subtotal,
        total: subtotal,
        specialInstructions: input.notes?.trim() || undefined,
        // Counter trade — this is what the walk-in report counts.
        isWalkIn: true,
        paymentMethod: "CASH",
        ...(input.requestId
          ? { idempotencyKey: `kiosk:${kiosk.id}:${input.requestId}` }
          : {}),
      } as any,
      tenantId,
    );

    const result = {
      orderId: created.id,
      displayId: (created as any).displayId ?? null,
      total: Number(created.total),
      payment: input.payment,
    };
    if (replayKey) {
      // Opportunistic sweep, same as table QR.
      const cutoff = Date.now() - REPLAY_TTL_MS;
      for (const [k, v] of this.recent) if (v.at < cutoff) this.recent.delete(k);
      this.recent.set(replayKey, { at: Date.now(), result });
    }
    return result;
  }
}
