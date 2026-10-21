import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
} from "@nestjs/common";
import { OnEvent } from "@nestjs/event-emitter";
import { usesTap } from "@orderhub/shared";
import { TapService } from "../payments/tap.service";
import { ReceiptEmailService } from "../payments/receipt-email.service";
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
//     There is therefore NO TAB to leave open, and the table is never put
//     into OCCUPIED by this flow. A prepaid ticket is a finished sale that
//     happens to carry a table number, exactly like a counter order; a floor
//     plan that went busy on payment and stayed busy until somebody
//     remembered to tap "Free table" was showing staff a bill that did not
//     exist. The payment listener near the bottom of this file is the
//     belt-and-braces half: when the money lands it frees a table this flow
//     left occupied, and refuses to touch one a human seated.
//
//     PAY_NOW also takes a name and an email before the card step. The guest
//     is paying in full and is owed a bill; an emailed one is the only kind a
//     phone can be handed. The address gets the itemised receipt the moment
//     the payment confirms, and lands in the restaurant's own customer list.
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

/**
 * Good enough for "will a receipt reach this?".
 *
 * Deliberately permissive — the job is catching the typo and the empty box,
 * not adjudicating RFC 5322. A guest who has just been asked for an address
 * and is one tap from their food should get "check that address", not a
 * rejection of a perfectly legal one.
 */
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export function isLikelyEmail(value: string | null | undefined): boolean {
  const v = String(value ?? "").trim();
  return v.length <= 254 && EMAIL_RE.test(v);
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

/**
 * How many of a phone's own order ids we'll look up at once. A party works
 * through a handful of rounds in an evening; the cap is only there so a
 * crafted query string can't turn one public request into a thousand-id
 * lookup.
 */
const MAX_MY_ORDERS = 40;

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
  /** Stripe direct-charge secret. Absent when alreadyPaid, and for a Tap
   *  shop, which pays on Tap's hosted page instead (checkoutUrl). */
  clientSecret?: string;
  /** Gulf (Tap) shops: send the phone here to pay. It comes back to
   *  /t/<token>?paid=<orderId>, the same landing a 3-D Secure redirect uses. */
  checkoutUrl?: string;
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
  private readonly logger = new Logger(TableQrService.name);
  private readonly recent = new Map<string, { at: number; result: unknown }>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly orders: OrdersService,
    private readonly payments: PaymentsService,
    private readonly tap: TapService,
    private readonly receipts: ReceiptEmailService,
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
      // Who takes the card. TAP means a hosted page (and Tap insists on an
      // email for the customer), STRIPE the on-page wallet sheet.
      cardProvider: usesTap(table.location?.country) ? "TAP" : "STRIPE",
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
      /** Required for a Tap shop — Tap won't take a charge without one. */
      customerEmail?: string;
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

    // Gulf shops take cards through Tap: a hosted page rather than the
    // on-page wallet sheet, on the brand's own Tap merchant. Every refusal
    // here happens BEFORE an order is written, for the same reason as the
    // Stripe pre-flight below — an orphan unpaid order per failed guest.
    const viaTap = usesTap(table.location?.country);

    // A name and an email are required on this path, whichever provider
    // takes the card. Tap has always needed the email (its hosted page
    // can't ask after the fact); Stripe doesn't, but the guest does — they
    // are paying in full, and an emailed bill is the only receipt a phone
    // can be handed. Falling back to the table name, which PAY_LATER does
    // quite reasonably for a round staff will settle face to face, would
    // put "Table 4" in the restaurant's customer list.
    const guestName = input.customerName?.trim() ?? "";
    const guestEmail = input.customerEmail?.trim().toLowerCase() ?? "";
    if (!guestName) {
      throw new BadRequestException("Please enter your name");
    }
    if (!isLikelyEmail(guestEmail)) {
      throw new BadRequestException(
        "Please enter an email address so we can send your receipt",
      );
    }

    if (viaTap) {
      if (!this.tap.configured()) {
        throw new BadRequestException(
          "This restaurant hasn't finished setting up card payments — please order with a member of staff",
        );
      }
      const brandId = table.location?.brand?.id ?? null;
      const brand = brandId
        ? await this.prisma.brand.findFirst({ where: { id: brandId } })
        : null;
      if (!(brand as any)?.tapMerchantId) {
        throw new BadRequestException(
          "This restaurant hasn't finished setting up card payments — please order with a member of staff",
        );
      }
    } else {
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
    }

    const items = this.cleanItems(input.items);
    const subtotal = items.reduce((s, i) => s + Number(i.totalPrice || 0), 0);

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
        // email rides in customerInfo because Order has no column for it —
        // the same place the storefront puts it, and what the receipt reads.
        customerInfo: { name: guestName, email: guestEmail },
        items: items as any,
        subtotal,
        total: subtotal,
        specialInstructions: input.notes?.trim() || undefined,
        // QR_CODE is not decoration. It is the flag the ingest path reads
        // to hold this order in "Waiting for payment" instead of printing
        // it, and the one confirmPaymentRow reads to release it.
        paymentMethod: "QR_CODE",
        paymentProvider: viaTap ? "TAP" : "STRIPE",
        paymentStatus: "PENDING",
        // Keeps it off the board and out of history until the card clears.
        guestPrepay: true,
        ...(input.requestId
          ? { idempotencyKey: `tableqrpay:${table.id}:${input.requestId}` }
          : {}),
      } as any,
      tenantId,
    );

    // The table is deliberately NOT touched. This used to mark it OCCUPIED,
    // which reads on the floor plan as "there's a bill running here" — and it
    // never cleared, because a prepaid ticket has no settle step to clear it.
    // Staff were left tapping "Free table" after every guest who had already
    // paid. A prepaid round is a finished sale with a table number on it; the
    // Orders board and the kitchen screen are where it belongs.
    //
    // currentOrderId was never set here either, and still isn't: that field
    // means "the open tab staff will settle", and linking a prepaid ticket
    // would hand a waiter a tab addRound refuses the moment it is paid.

    // The restaurant's own customer list. Best-effort on purpose: a CRM
    // write failing is not a reason to refuse a guest who is mid-payment,
    // and the address is already on the order either way.
    await this.rememberGuest({
      tenantId,
      orderId: order.id,
      email: guestEmail,
      name: guestName,
    }).catch(() => undefined);

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

    if (viaTap) {
      const web = (process.env.WEB_URL ?? "https://www.orderhubsolutions.com").replace(/\/+$/, "");
      const [firstName, ...rest] = guestName.split(/\s+/);
      const { redirectUrl } = await this.tap.createCharge({
        tenantId,
        orderId: order.id,
        // The same landing a 3-D Secure redirect uses: the phone shows the
        // confirmation and polls until the webhook has paid the order.
        redirectUrl: `${web}/t/${encodeURIComponent(token)}?paid=${encodeURIComponent(order.id)}`,
        webhookUrl: `${(process.env.API_URL ?? "").replace(/\/+$/, "")}/v1/payments/tap/webhook`,
        customer: {
          firstName: firstName || "Guest",
          lastName: rest.join(" ") || undefined,
          email: guestEmail,
        },
      });
      const out: TableQrCheckoutResult = {
        orderId: order.id,
        tableName: table.name,
        checkoutUrl: redirectUrl,
        subtotal: Number(order.subtotal ?? subtotal),
        serviceCharge,
        serviceChargeLabel: svcLabel,
        total,
      };
      if (replayKey) this.remember(replayKey, out);
      return out;
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
      // Ask whichever provider took the card. A Tap redirect routinely beats
      // Tap's webhook back, and a webhook that never arrives is exactly what
      // this poll exists to survive.
      await (usesTap(table.location?.country)
        ? this.tap.reconcileOrder(order.id)
        : this.payments.reconcileOrderPayment(order.id)
      ).catch(() => undefined);
      const fresh = await this.prisma.order.findUnique({
        where: { id: order.id },
        select: { status: true, paymentStatus: true },
      });
      if (fresh) Object.assign(order, fresh);
    }

    // Second chance at the post-payment steps. `payment.authorized` only
    // fires while the order is still PENDING, so a ticket staff accepted by
    // hand before the webhook landed would never free its table or send its
    // bill. This rides the poll the guest is already making; both halves are
    // idempotent (the receipt has a marker, the table update is
    // conditional), so the common case where the listener already did the
    // work costs one read.
    if (order.paymentStatus === "PAID") {
      const tenantId = table.location?.brand?.tenantId;
      if (tenantId) {
        await this.settlePrepaidTableOrder(order.id, tenantId).catch((e) =>
          this.logger.warn(
            `Prepaid table order ${order.id}: catch-up settle failed: ${e?.message ?? e}`,
          ),
        );
      }
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
   * PAY_LATER reads the one growing tab: it is the table's shared bill and
   * everyone sitting there is on it.
   *
   * PAY_NOW has no tab, so the phone passes the ids of the orders IT paid
   * for and gets those back. That is not just convenience — a prepaid table
   * is never opened or freed, so there is no sitting boundary on the table
   * row to scope by, and anything table-wide would show tonight's second
   * party what the first one ate. Each id is still checked against this
   * table, so a guessed one from elsewhere resolves to nothing.
   */
  async myTab(token: string, myOrderIds: string[] = []) {
    const { table, paymentMode } = await this.openTable(token);

    const orderIds: string[] = [];
    if (table.currentOrderId) orderIds.push(table.currentOrderId);

    if (paymentMode === "PAY_NOW" && myOrderIds.length > 0) {
      const mine = await this.prisma.order.findMany({
        where: {
          id: { in: myOrderIds.slice(0, MAX_MY_ORDERS) },
          tableId: table.id,
          status: { notIn: ["CANCELLED", "REJECTED", "FAILED"] },
        },
        select: { id: true },
        orderBy: { createdAt: "asc" },
      });
      for (const o of mine) if (!orderIds.includes(o.id)) orderIds.push(o.id);
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

  // ── What happens when the money lands ──────────────────────────────────

  /**
   * A payment we collected has just confirmed.
   *
   * This is the same event the auto-accept listener runs on, fired by
   * PaymentsService.confirmPaymentRow once the order is PAID — so by the
   * time we read the row the money is genuinely in, not merely authorised.
   * Tap reaches the same place: settleCharge calls confirmPaymentRow too,
   * which is why one listener covers both providers.
   *
   * Everything below is best-effort and swallowed. A receipt that doesn't
   * send, or a table that doesn't clear, must never stop the order reaching
   * the kitchen.
   */
  @OnEvent("payment.authorized")
  async onPaymentAuthorized(ev: {
    orderId: string;
    tenantId: string;
  }): Promise<void> {
    await this.settlePrepaidTableOrder(ev.orderId, ev.tenantId).catch((e) =>
      this.logger.warn(
        `Prepaid table order ${ev.orderId}: post-payment steps failed: ${e?.message ?? e}`,
      ),
    );
  }

  /**
   * Close the table and send the bill, for a paid QR-at-table order.
   *
   * Scoped hard to THIS flow (`QR_CODE` + `PAID` + a table), because the
   * listener above sees every payment the platform collects.
   */
  private async settlePrepaidTableOrder(orderId: string, tenantId: string) {
    const order = await this.prisma.order.findFirst({
      where: { id: orderId, tenantId },
      select: {
        id: true,
        tableId: true,
        paymentMethod: true,
        paymentStatus: true,
        customerInfo: true,
        metadata: true,
      },
    });
    if (!order?.tableId) return;
    if (order.paymentMethod !== "QR_CODE" || order.paymentStatus !== "PAID") {
      return;
    }

    await this.freeTableIfNobodyClaimedIt(order.tableId, orderId);
    await this.emailTheBill(tenantId, order);
  }

  /**
   * Clear the table, unless a human is using it.
   *
   * Expressed as ONE conditional update rather than read-then-write, so two
   * guests paying in the same second can't both decide the table is theirs
   * to clear. Every condition is a reason to leave it alone:
   *
   *   status OCCUPIED  — nothing to do for a table already free.
   *   currentOrderId   — a waiter has a real tab running. Freeing it would
   *                      orphan a bill nobody has collected.
   *   serverId/Name    — someone claimed this table as their section.
   *   covers           — staff recorded a guest count, so this is a sitting.
   *
   * A PAY_NOW checkout no longer occupies anything, so this is mostly
   * housekeeping: it clears tables left OCCUPIED by the first build of this
   * feature, and any an earlier round of the guest's own had marked.
   */
  private async freeTableIfNobodyClaimedIt(tableId: string, orderId: string) {
    const { count } = await this.prisma.table.updateMany({
      where: {
        id: tableId,
        status: "OCCUPIED",
        currentOrderId: null,
        serverId: null,
        serverName: null,
        covers: null,
      },
      data: { status: "FREE", openedAt: null },
    });
    if (count > 0) {
      this.logger.log(
        `Table ${tableId} freed — prepaid order ${orderId} settled, no tab to collect`,
      );
    }
  }

  /**
   * Email the itemised bill, once.
   *
   * Sent, THEN marked. The other order risks a guest who paid never getting
   * a receipt because the send failed after the marker was written, and a
   * duplicate receipt is a far smaller problem than a missing one. The
   * marker only has to survive the webhook-versus-poll race, which is
   * seconds wide.
   */
  private async emailTheBill(
    tenantId: string,
    order: { id: string; customerInfo: unknown; metadata: unknown },
  ) {
    const to = String((order.customerInfo as any)?.email ?? "").trim();
    if (!isLikelyEmail(to)) return;

    const metadata = ((order.metadata as any) ?? {}) as Record<string, unknown>;
    if (metadata.tableQrReceiptEmailedAt) return;

    await this.receipts.sendOrderReceipt({ tenantId, orderId: order.id, to });
    await this.prisma.order.update({
      where: { id: order.id },
      data: {
        metadata: {
          ...metadata,
          tableQrReceiptEmailedAt: new Date().toISOString(),
        } as any,
      },
    });
  }

  /**
   * Put the guest in the restaurant's own customer list, and point the order
   * at them so it shows on their record.
   *
   * An existing row is never overwritten — a name the shop curated, or one
   * from a previous visit, beats whatever was typed into a phone at a table
   * tonight. The one exception is filling in a blank name, which is how a
   * customer first created from a bare email address gets one.
   *
   * marketingConsent stays at its `false` default. This address was given so
   * a bill could be sent; that is not permission to market to it.
   */
  private async rememberGuest(args: {
    tenantId: string;
    orderId: string;
    email: string;
    name: string;
  }) {
    const email = args.email.trim().toLowerCase();
    const parts = args.name.trim().split(/\s+/).filter(Boolean);
    const firstName = parts[0] ?? null;
    const lastName = parts.length > 1 ? parts.slice(1).join(" ") : null;

    const customer = await this.prisma.customer.upsert({
      where: { tenantId_email: { tenantId: args.tenantId, email } },
      update: {},
      create: { tenantId: args.tenantId, email, firstName, lastName },
      select: { id: true, firstName: true },
    });

    if (firstName && !String(customer.firstName ?? "").trim()) {
      await this.prisma.customer.update({
        where: { id: customer.id },
        data: { firstName, lastName },
      });
    }

    await this.prisma.order.update({
      where: { id: args.orderId },
      data: { customerId: customer.id },
    });
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
