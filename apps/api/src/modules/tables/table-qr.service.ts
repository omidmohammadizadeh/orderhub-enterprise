import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
} from "@nestjs/common";
import { usesTap } from "@orderhub/shared";
import { PrismaService } from "../../infrastructure/database/prisma.service";
import { OrdersService } from "../orders/orders.service";
import { PaymentsService } from "../payments/payments.service";

// QR at table — a guest scans the sticker on their table and orders from
// their own phone.
//
// There are two ways a shop can run this, chosen per location in
// Tables → Payment options:
//
//   PAY_LATER (the default, and what this has always done)
//     The round lands on that table's existing tab, so the bill, the
//     kitchen routing and the settle path are all the ones staff already
//     use. Nothing here touches money — it's paid at the end, with staff,
//     exactly like a waiter round.
//
//   PAY_NOW
//     The guest pays on their phone (Apple Pay / Google Pay / card) BEFORE
//     anything reaches the kitchen — the Nando's model. Each paid basket is
//     its own DINE_IN order stamped with the table, not a line on a growing
//     tab: a tab that is already settled can't be appended to (addRound
//     refuses a PAID order), and "one paid ticket per round" is what the
//     kitchen and the till both already understand.
//
// The money path is the storefront's, unchanged: the order is written
// FIRST as paymentMethod=QR_CODE / paymentStatus=PENDING, which the ingest
// path already knows to hold out of the New column and out of auto-accept,
// then a direct-charge PaymentIntent is minted on the shop's connected
// account. The Stripe webhook (payment_intent.succeeded → confirmPayment)
// is what flips it to PAID and releases it to the board, the printer and
// the KDS. Nothing reaches the kitchen on the phone's say-so.
//
// Security model: the token is the only credential, so it is
//   • opaque and rotatable (POST /tables/:id/qr mints a fresh one, which
//     instantly kills any sticker already on the table),
//   • individually switchable (qrEnabled),
//   • gated on the LOCATION having table service on,
//   • never accepted for a table that is out of service.
//
// A scan can only ever ADD to the table it belongs to. It cannot read
// other tables, cannot settle, cannot discount.

export interface QrOrderItem {
  name: string;
  quantity: number;
  unitPrice: number;
  totalPrice: number;
  modifiers?: { name: string; price: number; quantity?: number }[];
  notes?: string | null;
  menuItemId?: string | null;
}

/**
 * How this location wants QR rounds paid for.
 *   PAY_LATER — send to the kitchen now, settle with staff at the end.
 *   PAY_NOW   — nothing goes to the kitchen until the phone has paid.
 */
export type TableQrPaymentMode = "PAY_LATER" | "PAY_NOW";

/** Read the mode off a Location.settings blob. Unset = the old behaviour. */
export function readTableQrPaymentMode(settings: unknown): TableQrPaymentMode {
  const raw = ((settings ?? {}) as any)?.tableService?.qrPayment;
  return raw === "PAY_NOW" ? "PAY_NOW" : "PAY_LATER";
}

// Guest phones drop connections constantly (lock screen, lift, patchy
// venue wifi). Without a guard, a retry after the request already
// reached us plates the round twice — the one failure mode that costs
// the restaurant real food. The phone sends a stable requestId per
// basket; we remember what we did with it for a few minutes and replay
// the same answer instead of cooking it again.
//
// In-memory is the right size for this: the whole risk window is
// seconds, the cost of a rare miss on a restarted/other instance is one
// duplicate round, and the alternative is a schema change for a cache.
// Both paths additionally pass the id through to orders.create()'s
// existing idempotencyKey, which IS durable.
const REPLAY_TTL_MS = 5 * 60_000;

export interface TableQrRoundResult {
  orderId: string;
  tableName: string;
  mode: "OPEN" | "ROUND";
}

export interface TableQrCheckoutResult {
  orderId: string;
  tableName: string;
  /** Already settled — the phone shows the confirmation, not a card sheet. */
  alreadyPaid?: boolean;
  /** Stripe direct-charge secret. Absent only when alreadyPaid. */
  clientSecret?: string;
  /** The connected account the intent was minted on. Stripe.js MUST be
   *  constructed with it or the secret won't confirm. */
  stripeAccountId?: string;
  /** What Stripe will actually take, in minor units — includes the service
   *  charge and any card surcharge. This is the number to show the guest. */
  amountPence?: number;
  /** Bill breakdown, so the phone can itemise instead of just quoting a
   *  total that's bigger than the basket it came from. */
  subtotal: number;
  serviceCharge: number;
  serviceChargeLabel: string;
  total: number;
}

@Injectable()
export class TableQrService {
  private readonly recent = new Map<string, { at: number; result: unknown }>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly orders: OrdersService,
    private readonly payments: PaymentsService,
  ) {}

  private replay<T>(key: string): T | null {
    const hit = this.recent.get(key);
    if (!hit) return null;
    if (Date.now() - hit.at > REPLAY_TTL_MS) {
      this.recent.delete(key);
      return null;
    }
    return hit.result as T;
  }

  private remember(key: string, result: unknown) {
    // Opportunistic sweep — this map only ever holds a few minutes of
    // one venue's scans, so a full pass is cheaper than a timer.
    const cutoff = Date.now() - REPLAY_TTL_MS;
    for (const [k, v] of this.recent) if (v.at < cutoff) this.recent.delete(k);
    this.recent.set(key, { at: Date.now(), result });
  }

  /**
   * The shared front door for every guest route: find the table behind a
   * token and refuse it for all the reasons a sticker stops being valid.
   * Every caller needs the same four checks, and a route that forgot one
   * would be a route that took orders for a table the shop had pulled.
   */
  private async openTable(token: string) {
    const table = await this.prisma.table.findFirst({
      where: { qrToken: token, qrEnabled: true, isActive: true },
      include: {
        location: {
          select: {
            id: true,
            name: true,
            country: true,
            settings: true,
            brand: { select: { id: true, name: true, slug: true, tenantId: true } },
          },
        },
      },
    });
    if (!table) throw new NotFoundException("This QR code is no longer valid");

    const settings = table.location?.settings ?? null;
    const ts = ((settings as any) ?? {})?.tableService ?? {};
    if (!ts.enabled) {
      throw new ForbiddenException("Table ordering isn't available here");
    }
    if (table.outOfService) {
      throw new ForbiddenException(
        "This table isn't taking orders — please ask a member of staff",
      );
    }

    return {
      table,
      settings,
      paymentMode: readTableQrPaymentMode(settings),
      tenantId: table.location?.brand?.tenantId ?? null,
    };
  }

  /**
   * Resolve a scanned token to just enough context for the guest's phone
   * to render the right menu. Deliberately thin — no other tables, no
   * takings, no customer data.
   */
  async resolve(token: string) {
    const { table, paymentMode } = await this.openTable(token);

    return {
      tableId: table.id,
      tableName: table.name,
      locationId: table.locationId,
      locationName: table.location?.name ?? null,
      brandId: table.location?.brand?.id ?? null,
      brandName: table.location?.brand?.name ?? null,
      brandSlug: table.location?.brand?.slug ?? null,
      // True once a waiter (or an earlier scan) has already opened the
      // tab — the phone can then show "adding to your table".
      tabOpen: !!table.currentOrderId,
      // Guests may be asked to confirm how many are eating, once.
      covers: table.covers,
      // Which of the two flows this shop runs. The phone renders a
      // "Send to kitchen" button or a "Pay & send" one off this.
      paymentMode,
    };
  }

  /**
   * Place a guest round on the table's tab — the PAY_LATER flow. Creates
   * the tab if this is the first order on the table, otherwise appends —
   * identical to what the POS does, so a table can mix waiter rounds and
   * phone rounds freely.
   */
  async placeOrder(
    token: string,
    input: {
      items: QrOrderItem[];
      customerName?: string;
      notes?: string | null;
      /** Stable per-basket id from the phone; makes retries safe. */
      requestId?: string;
    },
  ): Promise<TableQrRoundResult> {
    const replayKey = input.requestId ? `round:${token}:${input.requestId}` : null;
    if (replayKey) {
      const already = this.replay<TableQrRoundResult>(replayKey);
      if (already) return already;
    }

    const { table, paymentMode, tenantId } = await this.openTable(token);
    if (!tenantId) throw new NotFoundException("Location not found");
    if (paymentMode === "PAY_NOW") {
      // The shop takes payment up front. Sending to the kitchen from here
      // would be a free meal, so it isn't a fallback — the phone is told to
      // use the checkout route instead.
      throw new ForbiddenException(
        "This restaurant takes payment before the kitchen starts — please pay for your order",
      );
    }

    const items = this.cleanItems(input.items);
    const guestName = input.customerName?.trim() || table.name;

    // Existing tab → append a round. This reuses the SAME path the POS
    // uses, so only the new lines fire to the kitchen and prior KDS
    // tick-states survive.
    if (table.currentOrderId) {
      const order = await this.orders.addRound(
        table.currentOrderId,
        tenantId,
        items,
        // No staff user behind a guest scan; attribute it to the table.
        `qr:${table.id}`,
      );
      const out: TableQrRoundResult = {
        orderId: order.id,
        tableName: table.name,
        mode: "ROUND",
      };
      if (replayKey) this.remember(replayKey, out);
      return out;
    }

    // First order on this table → open the tab.
    const subtotal = items.reduce((s, i) => s + Number(i.totalPrice || 0), 0);
    const created = await this.orders.create(
      {
        locationId: table.locationId,
        brandId: table.location?.brand?.id ?? undefined,
        orderSource: "POS",
        fulfillmentType: "DINE_IN",
        tableId: table.id,
        customerInfo: { name: guestName },
        items: items as any,
        subtotal,
        total: subtotal,
        specialInstructions: input.notes?.trim() || undefined,
        // Durable dedupe for the first round — create() already
        // supports this, so an OPEN retry can't produce two tabs.
        ...(input.requestId
          ? { idempotencyKey: `tableqr:${table.id}:${input.requestId}` }
          : {}),
      } as any,
      tenantId,
    );

    await this.prisma.table.update({
      where: { id: table.id },
      data: {
        status: "OCCUPIED",
        currentOrderId: created.id,
        openedAt: table.openedAt ?? new Date(),
      },
    });

    const out: TableQrRoundResult = {
      orderId: created.id,
      tableName: table.name,
      mode: "OPEN",
    };
    if (replayKey) this.remember(replayKey, out);
    return out;
  }

  /**
   * PAY_NOW — write the order unpaid and hand the phone a PaymentIntent.
   *
   * Order first, intent second, deliberately: minting a secret from a
   * public route keyed on an order id would let anyone who can guess an id
   * start a payment against someone else's order. It's the same ordering
   * the storefront uses, for the same reason.
   *
   * The order is stamped paymentMethod=QR_CODE / paymentStatus=PENDING,
   * which is what keeps it out of the kitchen: ingestCanonical already
   * suppresses the new-order broadcast and auto-accept for an unpaid
   * QR_CODE order, and confirmPaymentRow already re-fires both once the
   * money lands. Nothing new decides when food gets cooked.
   */
  async checkout(
    token: string,
    input: {
      items: QrOrderItem[];
      customerName?: string;
      notes?: string | null;
      requestId?: string;
    },
  ): Promise<TableQrCheckoutResult> {
    const replayKey = input.requestId ? `pay:${token}:${input.requestId}` : null;
    if (replayKey) {
      const already = this.replay<TableQrCheckoutResult>(replayKey);
      if (already) return already;
    }

    const { table, settings, paymentMode, tenantId } = await this.openTable(token);
    if (!tenantId) throw new NotFoundException("Location not found");
    if (paymentMode !== "PAY_NOW") {
      throw new ForbiddenException(
        "This table settles at the end — send your order to the kitchen instead",
      );
    }

    // Gulf shops take cards through Tap, not Stripe, and Tap is
    // hosted-redirect only — there is no on-page wallet sheet to mount.
    // Say so plainly here rather than failing later inside Stripe, and the
    // dashboard refuses to switch PAY_NOW on for these countries at all.
    if (usesTap(table.location?.country)) {
      throw new BadRequestException(
        "Paying at the table isn't available at this restaurant yet — please ask a member of staff",
      );
    }

    // Pre-flight the connected account BEFORE writing a row. A shop that
    // never finished Stripe onboarding would otherwise leave an orphan
    // unpaid order on the staff board for every guest who tried.
    const connect = await this.payments.resolveConnectAccount(
      tenantId,
      table.locationId,
      table.location?.brand?.id ?? null,
    );
    if (!connect) {
      throw new BadRequestException(
        "This restaurant hasn't finished setting up card payments — please order with a member of staff",
      );
    }

    const items = this.cleanItems(input.items);
    const subtotal = items.reduce((s, i) => s + Number(i.totalPrice || 0), 0);
    const guestName = input.customerName?.trim() || table.name;

    // Each paid basket is its own ticket — see the note at the top of the
    // file. The table is stamped on it so the kitchen, the board and the
    // receipt all say which table it belongs to.
    const order = await this.orders.create(
      {
        locationId: table.locationId,
        brandId: table.location?.brand?.id ?? undefined,
        orderSource: "POS",
        fulfillmentType: "DINE_IN",
        tableId: table.id,
        customerInfo: { name: guestName },
        items: items as any,
        subtotal,
        total: subtotal,
        specialInstructions: input.notes?.trim() || undefined,
        // QR_CODE is not decoration. It is the flag the ingest path reads
        // to hold this order in "Waiting for payment" instead of printing
        // it, and the one confirmPaymentRow reads to release it.
        paymentMethod: "QR_CODE",
        paymentProvider: "STRIPE",
        paymentStatus: "PENDING",
        ...(input.requestId
          ? { idempotencyKey: `tableqrpay:${table.id}:${input.requestId}` }
          : {}),
      } as any,
      tenantId,
    );

    // The party is sitting there whether or not they've paid yet, so the
    // floor plan should say so. currentOrderId is deliberately left alone:
    // that field means "the open tab staff will settle", and a prepaid
    // ticket is not one. Linking it would hand a waiter a tab that
    // addRound refuses the moment it's paid.
    if (table.status !== "OCCUPIED" || !table.openedAt) {
      await this.prisma.table.update({
        where: { id: table.id },
        data: { status: "OCCUPIED", openedAt: table.openedAt ?? new Date() },
      });
    }

    const svcLabel =
      (((settings as any) ?? {})?.serviceCharge?.label as string)?.trim() ||
      "Service charge";
    const serviceCharge = Number((order as any).serviceCharge ?? 0);
    const total = Number(order.total ?? 0);

    // A repeat of a basket that already went through — the durable
    // idempotencyKey handed us back the same order. Don't mint a second
    // intent against it; tell the phone it's done.
    if ((order as any).paymentStatus === "PAID") {
      const paid: TableQrCheckoutResult = {
        orderId: order.id,
        tableName: table.name,
        alreadyPaid: true,
        subtotal: Number(order.subtotal ?? subtotal),
        serviceCharge,
        serviceChargeLabel: svcLabel,
        total,
      };
      if (replayKey) this.remember(replayKey, paid);
      return paid;
    }

    const { clientSecret, amountPence, stripeAccountId } =
      await this.payments.createStorefrontPaymentIntent({
        tenantId,
        orderId: order.id,
      });

    const out: TableQrCheckoutResult = {
      orderId: order.id,
      tableName: table.name,
      clientSecret,
      stripeAccountId,
      amountPence,
      subtotal: Number(order.subtotal ?? subtotal),
      serviceCharge,
      serviceChargeLabel: svcLabel,
      total,
    };
    if (replayKey) this.remember(replayKey, out);
    return out;
  }

  /**
   * Did my payment land? The phone polls this after confirming a card.
   *
   * Belt-and-braces, exactly as the storefront's status route does it: if
   * the order is still PENDING we ask Stripe directly. Direct charges fire
   * webhooks on the CONNECTED account, and an operator whose endpoint
   * isn't subscribed to those would otherwise leave a paid order sitting
   * unpaid — money taken, kitchen never told.
   *
   * Scoped to the scanned table: an order id from another table is a 404,
   * not a peek at someone else's bill.
   */
  async orderStatus(token: string, orderId: string) {
    const { table } = await this.openTable(token);
    const order = await this.prisma.order.findFirst({
      where: { id: orderId, tableId: table.id },
      select: {
        id: true,
        displayId: true,
        orderNumber: true,
        status: true,
        paymentStatus: true,
        total: true,
      },
    });
    if (!order) throw new NotFoundException("Order not found");

    if (order.paymentStatus === "PENDING") {
      await this.payments
        .reconcileOrderPayment(order.id)
        .catch(() => undefined);
      const fresh = await this.prisma.order.findUnique({
        where: { id: order.id },
        select: { status: true, paymentStatus: true },
      });
      if (fresh) Object.assign(order, fresh);
    }

    return {
      orderId: order.id,
      displayId: order.displayId ?? null,
      orderNumber: order.orderNumber ?? null,
      status: order.status,
      paymentStatus: order.paymentStatus,
      total: Number(order.total),
      paid: order.paymentStatus === "PAID",
    };
  }

  /**
   * What's on my table so far. Guests get their own running total and
   * nothing else — no other tables, no staff notes, no payment data.
   *
   * PAY_LATER reads the one growing tab. PAY_NOW has no tab to read, so it
   * gathers this sitting's paid tickets for the table instead — same
   * question ("what have we ordered?"), different shape underneath.
   */
  async myTab(token: string) {
    const { table, paymentMode } = await this.openTable(token);

    const orderIds: string[] = [];
    if (table.currentOrderId) orderIds.push(table.currentOrderId);

    if (paymentMode === "PAY_NOW") {
      // This sitting only. openedAt is set the moment the first basket is
      // checked out; the midnight floor is for a table nobody ever freed,
      // so last night's party doesn't reappear on today's bill.
      const since = table.openedAt ?? startOfToday();
      const paid = await this.prisma.order.findMany({
        where: {
          tableId: table.id,
          createdAt: { gte: since },
          paymentStatus: "PAID",
          status: { notIn: ["CANCELLED", "REJECTED", "FAILED"] },
        },
        select: { id: true },
        orderBy: { createdAt: "asc" },
      });
      for (const o of paid) if (!orderIds.includes(o.id)) orderIds.push(o.id);
    }

    if (!orderIds.length) {
      return {
        tableName: table.name,
        items: [],
        total: 0,
        open: false,
        paymentMode,
      };
    }

    const orders = await this.prisma.order.findMany({
      where: { id: { in: orderIds } },
      include: {
        items: {
          select: { id: true, name: true, quantity: true, totalPrice: true },
        },
      },
      orderBy: { createdAt: "asc" },
    });

    return {
      tableName: table.name,
      open: true,
      paymentMode,
      items: orders.flatMap((o) =>
        o.items.map((i) => ({
          id: i.id,
          name: i.name,
          quantity: i.quantity,
          totalPrice: Number(i.totalPrice),
        })),
      ),
      total: orders.reduce((s, o) => s + Number(o.total ?? 0), 0),
      // One tab has one status; a pile of prepaid tickets is PAID by
      // construction, which is the honest answer for both shapes.
      paymentStatus:
        orders.length === 1 ? (orders[0]?.paymentStatus ?? null) : "PAID",
    };
  }

  /** Drop the empty/zero lines a flaky phone can send, and refuse a
   *  genuinely empty basket rather than opening a £0 tab on the floor. */
  private cleanItems(raw: QrOrderItem[] | undefined): QrOrderItem[] {
    const items = (raw ?? []).filter(
      (i) => i?.name && Number(i.quantity) > 0,
    );
    if (!items.length) throw new BadRequestException("Your basket is empty");
    return items;
  }
}

function startOfToday(): Date {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}
