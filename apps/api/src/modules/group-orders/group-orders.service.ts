import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from "@nestjs/common";
import { randomBytes } from "crypto";
import { PrismaService } from "../../infrastructure/database/prisma.service";

// Group ordering — a shared basket several people add to before it becomes
// one order.
//
// The basket is NOT an Order. It only becomes one when the host places it, so
// an abandoned basket never reaches the kitchen or the order board.
//
// Guests join by link with a name, no account. Each guest gets a browser-
// scoped `ref` so they can edit their OWN lines and nobody else's — the whole
// trust model here, since there is no login to check.

/** How long an untouched basket stays joinable. */
const DEFAULT_TTL_HOURS = 6;

@Injectable()
export class GroupOrdersService {
  private readonly logger = new Logger(GroupOrdersService.name);

  constructor(private readonly prisma: PrismaService) {}

  private db() {
    return this.prisma as any;
  }

  /** URL-safe token for the share link. */
  private newToken(): string {
    return randomBytes(9).toString("base64url");
  }

  // ── Host ────────────────────────────────────────────────────────────────
  async create(input: {
    tenantId: string;
    locationId: string;
    brandId?: string;
    hostName: string;
    hostCustomerId?: string;
    fulfillmentType?: string;
    paymentMode?: string;
  }) {
    if (!input.hostName?.trim()) {
      throw new BadRequestException("A name is required to start a group order");
    }
    const expiresAt = new Date(Date.now() + DEFAULT_TTL_HOURS * 3600_000);
    return this.db().groupOrder.create({
      data: {
        tenantId: input.tenantId,
        token: this.newToken(),
        locationId: input.locationId,
        brandId: input.brandId ?? null,
        hostName: input.hostName.trim(),
        hostCustomerId: input.hostCustomerId ?? null,
        fulfillmentType: input.fulfillmentType ?? "DELIVERY",
        // HOST_PAYS needs no per-guest payment step and is what most real
        // group orders do. SPLIT is phase 2.
        paymentMode: input.paymentMode === "SPLIT" ? "SPLIT" : "HOST_PAYS",
        expiresAt,
      },
    });
  }

  // ── Guests ──────────────────────────────────────────────────────────────

  /**
   * Load a basket by its public token. Everything a guest does goes through
   * here, so this is the single place that decides whether a basket is still
   * usable.
   */
  private async openBasket(token: string) {
    const basket = await this.db().groupOrder.findUnique({ where: { token } });
    if (!basket) throw new NotFoundException("Group order not found");
    if (basket.status === "PLACED") {
      throw new BadRequestException("This group order has already been placed");
    }
    if (basket.status === "CANCELLED" || basket.status === "EXPIRED") {
      throw new BadRequestException("This group order is closed");
    }
    if (basket.expiresAt && basket.expiresAt < new Date()) {
      // Mark it rather than just refusing, so it stops appearing as open.
      await this.db().groupOrder.updateMany({
        where: { id: basket.id, status: "OPEN" },
        data: { status: "EXPIRED" },
      });
      throw new BadRequestException("This group order has expired");
    }
    return basket;
  }

  /** Public view — the basket plus every line, grouped by who added it. */
  async getByToken(token: string) {
    const basket = await this.db().groupOrder.findUnique({ where: { token } });
    if (!basket) throw new NotFoundException("Group order not found");
    const items = await this.db().groupOrderItem.findMany({
      where: { groupOrderId: basket.id },
      orderBy: { createdAt: "asc" },
    });
    return { ...basket, items, ...this.summarise(items) };
  }

  /**
   * Per-person totals. The kitchen ticket and the split-pay screen both need
   * the basket broken down by person, so it's computed once here.
   */
  private summarise(items: any[]) {
    const people = new Map<string, { name: string; total: number; count: number }>();
    let subtotal = 0;
    for (const it of items) {
      subtotal += it.lineTotal;
      const cur = people.get(it.addedByRef) ?? {
        name: it.addedByName,
        total: 0,
        count: 0,
      };
      cur.total += it.lineTotal;
      cur.count += it.quantity;
      people.set(it.addedByRef, cur);
    }
    return {
      subtotal: Math.round(subtotal * 100) / 100,
      people: [...people.entries()].map(([ref, p]) => ({ ref, ...p })),
    };
  }

  async addItem(
    token: string,
    input: {
      addedByName: string;
      addedByRef: string;
      cartItem: unknown;
      quantity: number;
      lineTotal: number;
    },
  ) {
    const basket = await this.openBasket(token);
    if (basket.status === "LOCKED") {
      throw new BadRequestException(
        "The host has closed this basket — no more items can be added",
      );
    }
    if (!input.addedByName?.trim() || !input.addedByRef?.trim()) {
      throw new BadRequestException("Tell us your name before adding items");
    }
    if (!Number.isFinite(input.lineTotal) || input.lineTotal < 0) {
      throw new BadRequestException("Invalid item price");
    }
    await this.db().groupOrderItem.create({
      data: {
        groupOrderId: basket.id,
        addedByName: input.addedByName.trim().slice(0, 40),
        addedByRef: input.addedByRef,
        cartItem: input.cartItem as any,
        quantity: Math.max(1, Math.floor(input.quantity) || 1),
        lineTotal: input.lineTotal,
      },
    });
    return this.getByToken(token);
  }

  /**
   * Remove one of YOUR OWN lines. `addedByRef` is the only credential a guest
   * has, so it's checked against the row rather than trusted from the body.
   */
  async removeItem(token: string, itemId: string, addedByRef: string) {
    const basket = await this.openBasket(token);
    const item = await this.db().groupOrderItem.findFirst({
      where: { id: itemId, groupOrderId: basket.id },
    });
    if (!item) throw new NotFoundException("Item not found");
    if (item.addedByRef !== addedByRef) {
      throw new ForbiddenException("You can only remove items you added");
    }
    if (item.isPaid) {
      // Removing a paid line would leave money collected against nothing.
      throw new BadRequestException(
        "That item has already been paid for and can't be removed",
      );
    }
    await this.db().groupOrderItem.delete({ where: { id: item.id } });
    return this.getByToken(token);
  }

  // ── Host closes the basket ──────────────────────────────────────────────

  /**
   * Stop accepting items so the total can't move while the host is paying.
   * Placing the order is the next step and is deliberately NOT wired yet —
   * see the module README note.
   */
  async lock(token: string) {
    const basket = await this.openBasket(token);
    const items = await this.db().groupOrderItem.count({
      where: { groupOrderId: basket.id },
    });
    if (items === 0) {
      throw new BadRequestException("The basket is empty");
    }
    await this.db().groupOrder.update({
      where: { id: basket.id },
      data: { status: "LOCKED" },
    });
    return this.getByToken(token);
  }

  /** Host reopens a locked basket (someone remembered they wanted chips). */
  async unlock(token: string) {
    const basket = await this.db().groupOrder.findUnique({ where: { token } });
    if (!basket) throw new NotFoundException("Group order not found");
    if (basket.status !== "LOCKED") {
      throw new BadRequestException("That basket isn't locked");
    }
    await this.db().groupOrder.update({
      where: { id: basket.id },
      data: { status: "OPEN" },
    });
    return this.getByToken(token);
  }

  async cancel(token: string) {
    const basket = await this.db().groupOrder.findUnique({ where: { token } });
    if (!basket) throw new NotFoundException("Group order not found");
    if (basket.status === "PLACED") {
      throw new BadRequestException("That group order has already been placed");
    }
    await this.db().groupOrder.update({
      where: { id: basket.id },
      data: { status: "CANCELLED" },
    });
    return { ok: true };
  }
}
