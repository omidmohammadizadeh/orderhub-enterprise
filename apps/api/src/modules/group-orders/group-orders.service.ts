import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from "@nestjs/common";
import { randomBytes } from "crypto";
import { PrismaService } from "../../infrastructure/database/prisma.service";
import { OrdersService } from "../orders/orders.service";
import { PaymentsService } from "../payments/payments.service";

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

  constructor(
    private readonly prisma: PrismaService,
    private readonly orders: OrdersService,
    private readonly payments: PaymentsService,
  ) {}

  private db() {
    return this.prisma as any;
  }

  /** URL-safe token for the share link. */
  private newToken(): string {
    return randomBytes(9).toString("base64url");
  }

  // ── Host ────────────────────────────────────────────────────────────────

  /**
   * Resolve the store a basket belongs to. The tenant is derived HERE from the
   * location rather than taken from the request body: this endpoint is public,
   * so a client-supplied tenantId would let anyone open a basket against
   * someone else's tenant. The storefront doesn't know its tenantId anyway.
   */
  private async resolveStore(locationId: string) {
    const location = await this.prisma.location.findFirst({
      where: {
        OR: [{ id: locationId }, { onlineOrderingSlug: locationId }, { slug: locationId }],
      },
      select: {
        id: true,
        slug: true,
        onlineOrderingSlug: true,
        isActive: true,
        deletedAt: true,
        brandId: true,
        brand: { select: { tenantId: true } },
      },
    });
    if (!location || !location.isActive || location.deletedAt) {
      throw new NotFoundException("Store not found");
    }
    return location;
  }

  async create(input: {
    locationId: string;
    brandId?: string;
    hostName: string;
    hostRef?: string;
    hostCustomerId?: string;
    fulfillmentType?: string;
    paymentMode?: string;
  }) {
    if (!input.hostName?.trim()) {
      throw new BadRequestException("A name is required to start a group order");
    }
    const location = await this.resolveStore(input.locationId);

    // Same rule the storefront checkout uses for its ?brand= pin: drop a brand
    // that isn't this tenant's rather than create a basket under someone
    // else's brand.
    let brandId: string | null = null;
    if (input.brandId) {
      const brand = await (this.prisma as any).brand.findUnique({
        where: { id: input.brandId },
        select: { id: true, tenantId: true },
      });
      if (brand && brand.tenantId === location.brand.tenantId) brandId = brand.id;
    }

    const expiresAt = new Date(Date.now() + DEFAULT_TTL_HOURS * 3600_000);
    const basket = await this.db().groupOrder.create({
      data: {
        tenantId: location.brand.tenantId,
        token: this.newToken(),
        locationId: location.id,
        brandId,
        hostName: input.hostName.trim().slice(0, 40),
        hostRef: input.hostRef?.trim() || null,
        hostCustomerId: input.hostCustomerId ?? null,
        fulfillmentType: input.fulfillmentType === "PICKUP" ? "PICKUP" : "DELIVERY",
        // HOST_PAYS needs no per-guest payment step and is what most real
        // group orders do. SPLIT is phase 2.
        paymentMode: input.paymentMode === "SPLIT" ? "SPLIT" : "HOST_PAYS",
        expiresAt,
      },
    });
    // Same shape every other route returns, so the storefront can render the
    // basket straight off the create response.
    return this.getByToken(basket.token, input.hostRef);
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

  /**
   * Public view — the basket plus every line, grouped by who added it.
   *
   * `ref` is the caller's own browser ref. It never grants anything on its
   * own; it only decides whether this caller is told they're the host.
   * hostRef is stripped from the payload: a guest who could read it could
   * lock and place the order.
   */
  async getByToken(token: string, ref?: string) {
    const basket = await this.db().groupOrder.findUnique({ where: { token } });
    if (!basket) throw new NotFoundException("Group order not found");
    const items = await this.db().groupOrderItem.findMany({
      where: { groupOrderId: basket.id },
      orderBy: { createdAt: "asc" },
    });
    const { hostRef, ...publicBasket } = basket;
    return {
      ...publicBasket,
      // Baskets opened before hostRef existed have no host to recognise, so
      // every link-holder is treated as the host on those — same trust model
      // they were created under.
      isHost: hostRef ? !!ref && ref === hostRef : true,
      items,
      ...this.summarise(items),
    };
  }

  /**
   * Gate the host-only actions — closing, reopening, placing, cancelling.
   * Without this, anyone who had the share link could place the order (and
   * choose the delivery address it goes to) before the host had finished
   * collecting everyone's items.
   */
  private assertHost(basket: any, ref?: string) {
    if (!basket.hostRef) return; // pre-hostRef basket — link-holder trust
    if (!ref || ref !== basket.hostRef) {
      throw new ForbiddenException(
        "Only the person who started this group order can do that",
      );
    }
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
    return this.getByToken(token, input.addedByRef);
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
    return this.getByToken(token, addedByRef);
  }

  // ── Host closes the basket ──────────────────────────────────────────────

  /**
   * Stop accepting items so the total can't move while the host is paying.
   * place() then requires LOCKED, so nobody can slip a line in between the
   * host seeing a total and agreeing to it.
   */
  async lock(token: string, hostRef?: string) {
    const basket = await this.openBasket(token);
    this.assertHost(basket, hostRef);
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
    return this.getByToken(token, hostRef);
  }

  /** Host reopens a locked basket (someone remembered they wanted chips). */
  async unlock(token: string, hostRef?: string) {
    const basket = await this.db().groupOrder.findUnique({ where: { token } });
    if (!basket) throw new NotFoundException("Group order not found");
    this.assertHost(basket, hostRef);
    if (basket.status !== "LOCKED") {
      throw new BadRequestException("That basket isn't locked");
    }
    await this.db().groupOrder.update({
      where: { id: basket.id },
      data: { status: "OPEN" },
    });
    return this.getByToken(token, hostRef);
  }

  /**
   * Turn the basket into a real Order.
   *
   * Deliberately does NOT invent a payment path: it composes a CreateOrderDto
   * and hands it to OrdersService.create, so a group order is created,
   * printed, routed and paid for exactly like any other online order. Phase 1
   * is HOST_PAYS, so there is one payer and one total — nothing to split.
   *
   * The basket's stored `cartItem` is the contract between the storefront and
   * this method: it must carry { name, unitPrice, menuItemId?, notes?,
   * modifiers? }. Both ends are ours, so the shape is defined here rather
   * than guessed.
   */
  async place(
    token: string,
    input: {
      customerInfo: { name: string; phone?: string; email?: string };
      deliveryAddress?: {
        line1: string;
        line2?: string;
        city: string;
        postcode: string;
        country?: string;
      };
      deliveryFee?: number;
      specialInstructions?: string;
      paymentMethod?: string;
      paymentStatus?: string;
      idempotencyKey?: string;
      hostRef?: string;
    },
  ) {
    const basket = await this.db().groupOrder.findUnique({ where: { token } });
    if (!basket) throw new NotFoundException("Group order not found");
    this.assertHost(basket, input.hostRef);
    if (basket.status === "PLACED") {
      // Idempotent: a double-tap on "Place order" returns the same order
      // rather than creating a second one.
      return this.db().order.findUnique({ where: { id: basket.orderId } });
    }
    if (basket.status !== "LOCKED") {
      throw new BadRequestException(
        "Close the basket before placing the order",
      );
    }
    const items = await this.db().groupOrderItem.findMany({
      where: { groupOrderId: basket.id },
      orderBy: { createdAt: "asc" },
    });
    if (!items.length) throw new BadRequestException("The basket is empty");

    const isDelivery = basket.fulfillmentType === "DELIVERY";
    if (isDelivery && !input.deliveryAddress) {
      throw new BadRequestException("A delivery address is required");
    }

    // Card group orders go down the SAME Stripe path as an ordinary online
    // order (authorise now, capture when staff accept). Fail before creating
    // the order if the shop can't take cards, so the host isn't left with a
    // placed order they have no way to pay for.
    const isCard = String(input.paymentMethod ?? "").toUpperCase() === "CARD";
    const location = await this.resolveStore(basket.locationId);
    if (isCard) {
      const connect = await this.payments.resolveConnectAccount(
        basket.tenantId,
        basket.locationId,
        basket.brandId,
      );
      if (!connect) {
        throw new BadRequestException(
          "This restaurant hasn't set up card payments yet. Please choose Cash, or contact the restaurant.",
        );
      }
    }

    const orderItems = items.map((it: any) => {
      const c = (it.cartItem ?? {}) as any;
      const name = String(c.name ?? "Item");
      const unitPrice = Number(c.unitPrice ?? it.lineTotal / (it.quantity || 1));
      return {
        // Whose line this is, carried into the item name so the kitchen
        // ticket can be bagged per person. This is the whole operational
        // point of group ordering for a collection order.
        name: `${name} (${it.addedByName})`,
        quantity: it.quantity,
        unitPrice: Math.round(unitPrice * 100) / 100,
        totalPrice: Math.round(it.lineTotal * 100) / 100,
        ...(c.menuItemId ? { menuItemId: String(c.menuItemId) } : {}),
        ...(c.notes ? { notes: String(c.notes) } : {}),
        ...(Array.isArray(c.modifiers) && c.modifiers.length
          ? {
              modifiers: c.modifiers.map((m: any) => ({
                name: String(m?.name ?? ""),
                price: Number(m?.price ?? 0),
                ...(m?.quantity ? { quantity: Number(m.quantity) } : {}),
              })),
            }
          : {}),
      };
    });

    const subtotal =
      Math.round(items.reduce((s: number, i: any) => s + i.lineTotal, 0) * 100) / 100;
    const deliveryFee = isDelivery ? Number(input.deliveryFee ?? 0) : 0;
    const total = Math.round((subtotal + deliveryFee) * 100) / 100;

    const dto: any = {
      locationId: basket.locationId,
      ...(basket.brandId ? { brandId: basket.brandId } : {}),
      orderSource: "ONLINE",
      fulfillmentType: isDelivery ? "DELIVERY" : "PICKUP",
      customerInfo: input.customerInfo,
      ...(input.deliveryAddress ? { deliveryAddress: input.deliveryAddress } : {}),
      items: orderItems,
      subtotal,
      ...(deliveryFee > 0 ? { deliveryFee } : {}),
      total,
      // Name the group on the ticket so the shop knows why one order has
      // items labelled with five different people on it.
      specialInstructions: [
        `GROUP ORDER — ${items.length} item(s) from ${
          new Set(items.map((i: any) => i.addedByRef)).size
        } people`,
        input.specialInstructions,
      ]
        .filter(Boolean)
        .join(" · "),
      paymentMethod: isCard ? "CARD" : (input.paymentMethod ?? "CASH"),
      // Never PAID at creation time: a card order is only paid once Stripe
      // says so, and a cash order once the shop takes the money.
      paymentStatus: "PENDING",
      ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
    };

    const order = await this.orders.create(dto, basket.tenantId);

    // Only mark PLACED once the order actually exists — if create() throws,
    // the basket stays LOCKED and the host can retry rather than being left
    // with a basket that claims to be placed and no order.
    await this.db().groupOrder.update({
      where: { id: basket.id },
      data: { status: "PLACED", orderId: (order as any).id, placedAt: new Date() },
    });
    this.logger.log(
      `group order ${basket.token} placed as order ${(order as any).id}`,
    );

    if (!isCard) return order;

    // Hosted Stripe Checkout, exactly as the ordinary storefront does it: the
    // host pays on Stripe's domain and lands on the same confirmation page,
    // and the order only reaches the staff board once the webhook reports
    // authorization. A failure here leaves a PLACED basket behind a real but
    // unpaid order — the shop sees it the moment it's paid for, and the host
    // gets a clear error rather than a silent success.
    const origin = (
      process.env.WEB_URL ?? "https://www.orderhubsolutions.com"
    ).replace(/\/+$/, "");
    const storeSlug =
      location.onlineOrderingSlug ?? location.slug ?? location.id;
    const brandQs = basket.brandId
      ? `&brand=${encodeURIComponent(basket.brandId)}`
      : "";
    const { url } = await this.payments.createCheckoutSession({
      tenantId: basket.tenantId,
      orderId: (order as any).id,
      successUrl: `${origin}/order/${storeSlug}/confirmation?orderId=${
        (order as any).id
      }&session_id={CHECKOUT_SESSION_ID}${brandQs}`,
      cancelUrl: `${origin}/order/${storeSlug}?canceledOrderId=${
        (order as any).id
      }${brandQs}`,
      customerEmail: input.customerInfo?.email,
    });
    return { ...(order as any), checkoutUrl: url };
  }

  async cancel(token: string, hostRef?: string) {
    const basket = await this.db().groupOrder.findUnique({ where: { token } });
    if (!basket) throw new NotFoundException("Group order not found");
    this.assertHost(basket, hostRef);
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
