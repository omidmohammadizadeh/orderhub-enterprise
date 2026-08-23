import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from "@nestjs/common";
import { createHmac, timingSafeEqual } from "crypto";
import {
  currencyForCountry,
  roundToCurrency,
  currencyDecimals,
} from "@orderhub/shared";
import { PrismaService } from "../../infrastructure/database/prisma.service";
import { PaymentsService } from "./payments.service";

// Tap Payments — the Gulf money path.
//
// ── Why this exists as its own service ──────────────────────────────────────
//
// Not preference. Stripe's UAE Connect rules allow a UAE platform only Custom
// accounts with destination charges or separate charges+transfers, and forbid
// `on_behalf_of`. Our storefront takes DIRECT charges on the merchant's own
// account, so the existing integration cannot legally be pointed at the Gulf —
// it would need rewriting for either provider. Tap also settles KNET, mada and
// BENEFIT, which Stripe cannot.
//
// ── How Tap's marketplace model maps onto ours ──────────────────────────────
//
// Stripe: charge lands on the MERCHANT's account, platform takes an
// application_fee_amount off it.
//
// Tap: the charge lands on the MARKETPLACE (us) and carries a `destinations`
// array naming each business's cut. "The remaining amount of the transaction
// after the split goes directly to your Marketplace account" — so our fee is
// the REMAINDER, not a line item. One destination for the brand, at
// total-minus-fee, and Tap keeps the rest for us.
//
// That inverts who holds the money, which matters for two things and is why
// this isn't a drop-in adapter: the merchant is paid by Tap's settlement run
// rather than owning the balance, and a refund has to name the destinations to
// claw back from.
//
// ── What is verified and what is not ────────────────────────────────────────
//
// Verified against developers.tap.company: the charge, refund and webhook
// contracts below — endpoints, field names, the `destinations` shape, the
// hashstring signature construction, and that `src_all` yields a hosted page
// at `transaction.url`.
//
// NOT verified, because Tap does not document it: the Create Business response
// shape, i.e. where a new sub-merchant's destination id actually appears. So
// onboarding is NOT automated here — `Brand.tapDestinationId` is set by the
// operator from Tap's dashboard, and this service refuses a charge without
// one. Automating it needs one real response payload from Tap first; the
// HubRise docs were wrong twice, and a guessed field path here would silently
// settle money to the wrong business.

const TAP_API_BASE = "https://api.tap.company/v2";

/** Tap's charge lifecycle. CAPTURED is the only one that means money moved. */
export type TapChargeStatus =
  | "INITIATED"
  | "IN_PROGRESS"
  | "ABANDONED"
  | "CANCELLED"
  | "FAILED"
  | "DECLINED"
  | "RESTRICTED"
  | "CAPTURED"
  | "VOID"
  | "TIMEDOUT"
  | "UNKNOWN";

export interface TapCharge {
  id: string;
  status: TapChargeStatus;
  amount: number;
  currency: string;
  transaction?: { url?: string; created?: string; expiry?: unknown };
  redirect?: { url?: string; status?: string };
  reference?: { order?: string; transaction?: string };
  response?: { code?: string; message?: string };
  metadata?: Record<string, string>;
  [k: string]: unknown;
}

/** The fields Tap signs its webhooks over, in this exact order. */
export interface TapSignable {
  id?: string;
  amount?: number | string;
  currency?: string;
  reference?: { gateway?: string; payment?: string };
  status?: string;
  created?: number | string;
}

/**
 * Rebuild the string Tap signs a charge/authorize/refund webhook over.
 *
 * Exported and pure so the exact concatenation is testable without HTTP. The
 * shape is Tap's, not ours: `x_` -prefixed field names run together with no
 * separator between pairs.
 *
 * The amount MUST carry exactly the decimals its currency has — Tap signs
 * "15.00", not "15", and KWD signs "1.250". Getting that wrong doesn't
 * mis-parse, it just fails the comparison, which reads as a rejected webhook
 * rather than as a formatting bug.
 */
export function tapHashString(o: TapSignable): string {
  const amount = Number(o.amount ?? 0).toFixed(currencyDecimals(o.currency));
  return [
    `x_id${o.id ?? ""}`,
    `x_amount${amount}`,
    `x_currency${o.currency ?? ""}`,
    `x_gateway_reference${o.reference?.gateway ?? ""}`,
    `x_payment_reference${o.reference?.payment ?? ""}`,
    `x_status${o.status ?? ""}`,
    `x_created${o.created ?? ""}`,
  ].join("");
}

/** Constant-time compare that can't throw on a length mismatch. */
export function signaturesMatch(expected: string, received: string): boolean {
  const a = Buffer.from(expected ?? "", "utf8");
  const b = Buffer.from(received ?? "", "utf8");
  if (a.length !== b.length || a.length === 0) return false;
  return timingSafeEqual(a, b);
}

/**
 * Split one order between the brand and the platform.
 *
 * Returns what to put in `destinations` — the brand's share only. Our fee is
 * whatever is left over, which Tap keeps automatically; naming it as a second
 * destination would try to pay the marketplace out of its own charge.
 *
 * A fee at or above the total, or a negative one, is treated as no split at
 * all: sending a zero or negative destination amount would either be rejected
 * or silently pay the merchant nothing, and neither is a thing to guess about
 * mid-checkout.
 */
export function splitForDestination(input: {
  totalAmount: number;
  platformFee: number;
  currency: string;
  destinationId: string;
}): Array<{ id: string; amount: number; currency: string }> {
  const total = roundToCurrency(input.totalAmount, input.currency);
  const fee = roundToCurrency(Math.max(0, input.platformFee), input.currency);
  const merchantShare = roundToCurrency(total - fee, input.currency);
  if (!(merchantShare > 0)) return [];
  return [
    { id: input.destinationId, amount: merchantShare, currency: input.currency },
  ];
}

@Injectable()
export class TapService {
  private readonly logger = new Logger(TapService.name);

  constructor(
    private readonly prisma: PrismaService,
    // Only for confirmPaymentRow — the ledger writes, the PAID flip, the board
    // broadcast and auto-accept are provider-agnostic and must not be
    // reimplemented per provider.
    private readonly payments: PaymentsService,
  ) {}

  private get secretKey(): string | null {
    return process.env.TAP_SECRET_KEY?.trim() || null;
  }

  private get apiBase(): string {
    return (process.env.TAP_API_BASE?.trim() || TAP_API_BASE).replace(/\/+$/, "");
  }

  /** Whether Tap is wired up at all. Checked before routing a shop to it, so
   *  a missing key is a clear refusal at checkout rather than a 500 mid-pay. */
  configured(): boolean {
    return !!this.secretKey;
  }

  private async call<T>(
    path: string,
    init: { method: string; body?: unknown },
  ): Promise<T> {
    const key = this.secretKey;
    if (!key) throw new BadRequestException("Card payments aren't configured.");
    const res = await fetch(`${this.apiBase}${path}`, {
      method: init.method,
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
        accept: "application/json",
      },
      ...(init.body ? { body: JSON.stringify(init.body) } : {}),
      signal: AbortSignal.timeout(15_000),
    });
    const text = await res.text();
    let body: any = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      // Tap answers with HTML on some gateway errors. Keep the raw text in
      // the log — a JSON parse error alone tells you nothing about why.
      this.logger.error(`Tap ${path} returned non-JSON (${res.status}): ${text.slice(0, 300)}`);
      throw new BadRequestException("The payment provider returned an unexpected response.");
    }
    if (!res.ok || body?.errors?.length) {
      const err = body?.errors?.[0];
      this.logger.error(
        `Tap ${init.method} ${path} failed ${res.status}: ${err?.code ?? "?"} ${err?.description ?? text.slice(0, 200)}`,
      );
      throw new BadRequestException(
        err?.description ?? "The payment couldn't be started. Please try again.",
      );
    }
    return body as T;
  }

  /**
   * Start a hosted card payment for one order.
   *
   * Hosted rather than embedded on purpose: `src_all` renders Tap's own page
   * with every method the merchant has enabled — in the Gulf that means KNET,
   * mada, BENEFIT and Apple Pay, not just cards — and each of those carries
   * its own redirect and 3-D Secure flow that an embedded field cannot host.
   *
   * Returns the URL to send the browser to. Nothing is settled here: the money
   * is confirmed by the webhook, which is the only thing that marks the order
   * paid.
   */
  async createCharge(params: {
    tenantId: string;
    orderId: string;
    redirectUrl: string;
    webhookUrl: string;
    customer: { firstName: string; lastName?: string; email?: string; phone?: string };
  }): Promise<{ chargeId: string; redirectUrl: string; amount: number; currency: string }> {
    const order = await this.prisma.order.findFirst({
      where: { id: params.orderId, tenantId: params.tenantId },
      include: {
        location: { select: { id: true, name: true, country: true, currency: true } },
        brand: {
          select: {
            id: true,
            name: true,
            tapDestinationId: true,
            applicationFeeMode: true,
            applicationFeeFixedAmount: true,
            applicationFeePercentage: true,
          } as any,
        } as any,
      },
    });
    if (!order) throw new NotFoundException("Order not found");
    const brand = (order as any).brand;
    const destinationId = brand?.tapDestinationId;
    if (!destinationId) {
      // Deliberately specific. "Payment failed" here sends an operator to
      // check their card details when what's missing is a Tap onboarding step
      // only they can complete.
      throw new BadRequestException(
        "This brand hasn't finished Tap onboarding — no destination is set, so there's nowhere for the money to settle. Choose Cash, or contact the restaurant.",
      );
    }

    const currency = (
      (order as any).location?.currency ||
      currencyForCountry((order as any).location?.country)
    ).toUpperCase();
    const total = roundToCurrency(Number(order.total), currency);
    const platformFee = await this.platformFeeFor(order, total, currency);

    const charge = await this.call<TapCharge>("/charges", {
      method: "POST",
      body: {
        amount: total,
        currency,
        // Tap's hosted page with every method the merchant has enabled.
        source: { id: "src_all" },
        // 3-D Secure is not optional in the Gulf in practice — the local
        // schemes mandate it, and a charge that skips it is declined by the
        // issuer rather than by Tap.
        threeDSecure: true,
        customer_initiated: true,
        customer: {
          first_name: params.customer.firstName || "Customer",
          ...(params.customer.lastName ? { last_name: params.customer.lastName } : {}),
          ...(params.customer.email ? { email: params.customer.email } : {}),
          ...(params.customer.phone ? { phone: parsePhone(params.customer.phone) } : {}),
        },
        description: `${brand?.name ?? (order as any).location?.name ?? "Order"} — ${order.displayId ?? order.id}`,
        // Our own id on their record, so a Tap dashboard row can be traced
        // back to an order without going through our database.
        reference: {
          order: order.displayId ?? order.id,
          // Tap dedupes on this, which is what stops a double-tapped Pay
          // button becoming two charges.
          idempotent: `ord_${order.id}`,
        },
        metadata: {
          orderId: order.id,
          tenantId: params.tenantId,
          locationId: order.locationId ?? "",
          brandId: brand?.id ?? "",
        },
        destinations: {
          destination: splitForDestination({
            totalAmount: total,
            platformFee,
            currency,
            destinationId,
          }),
        },
        post: { url: params.webhookUrl },
        redirect: { url: params.redirectUrl },
      },
    });

    const url = charge.transaction?.url;
    if (!url) {
      this.logger.error(
        `Tap charge ${charge.id} came back with no transaction.url (status ${charge.status})`,
      );
      throw new BadRequestException("The payment couldn't be started. Please try again.");
    }

    await this.recordPendingPayment({
      tenantId: params.tenantId,
      order,
      charge,
      currency,
      total,
      platformFee,
    });

    return { chargeId: charge.id, redirectUrl: url, amount: total, currency };
  }

  /** Read a charge back from Tap. Used to reconcile an order whose webhook
   *  never arrived — the customer is back on the confirmation page and Tap is
   *  the only thing that knows whether their money moved. */
  async retrieveCharge(chargeId: string): Promise<TapCharge> {
    return this.call<TapCharge>(`/charges/${encodeURIComponent(chargeId)}`, {
      method: "GET",
    });
  }

  /**
   * Refund a Tap charge, reversing the split.
   *
   * `destinations` has to be named on the refund too: without it Tap takes the
   * whole refund out of the marketplace balance, so we would be handing the
   * customer their money back out of our own pocket while the merchant keeps
   * their share of a cancelled order.
   */
  async refundCharge(params: {
    chargeId: string;
    amount: number;
    currency: string;
    reason: string;
    destinationId?: string | null;
    destinationAmount?: number;
  }): Promise<{ id: string; status: string }> {
    const currency = params.currency.toUpperCase();
    const amount = roundToCurrency(params.amount, currency);
    const share =
      params.destinationId && params.destinationAmount != null
        ? roundToCurrency(params.destinationAmount, currency)
        : null;
    return this.call<{ id: string; status: string }>("/refunds", {
      method: "POST",
      body: {
        charge_id: params.chargeId,
        amount,
        currency,
        reason: params.reason,
        ...(share && share > 0
          ? {
              destinations: {
                destination: [
                  { id: params.destinationId, amount: share, currency },
                ],
              },
            }
          : {}),
        reference: { idempotent: `rf_${params.chargeId}_${toUnits(amount, currency)}` },
      },
    });
  }

  /**
   * Verify a webhook against the `hashstring` header.
   *
   * Signed with our SECRET key, over a string Tap builds from six fields of
   * the object — see tapHashString. An unverified body is not a payment: Tap's
   * webhook URL is public and posting a CAPTURED charge to it is otherwise all
   * it would take to mark any order paid.
   */
  verifyWebhook(body: TapSignable, hashstring: string | undefined): boolean {
    const key = this.secretKey;
    if (!key || !hashstring) return false;
    const expected = createHmac("sha256", key)
      .update(tapHashString(body))
      .digest("hex");
    return signaturesMatch(expected, hashstring);
  }

  /**
   * Settle a charge we have been told about — by webhook, or by reading it
   * back when the webhook never arrived.
   *
   * Idempotent on our side as well as Tap's: a Payment row already SUCCEEDED
   * short-circuits, so a replayed webhook cannot double-credit a ledger. Tap
   * retries on any non-2xx, so this WILL be called more than once.
   *
   * Only CAPTURED means the money moved. Every other terminal status marks the
   * payment failed and leaves the order unpaid — deliberately not cancelled,
   * because a customer whose card was declined usually tries again, and
   * binning their basket is a worse outcome than an order sitting unpaid.
   */
  async settleCharge(charge: TapCharge): Promise<void> {
    const payment = await (this.prisma as any).payment.findFirst({
      where: { providerChargeId: charge.id },
    });
    if (!payment) {
      this.logger.warn(`Tap webhook for unknown charge ${charge.id} — ignoring`);
      return;
    }
    if (charge.status === "CAPTURED") {
      await this.payments.confirmPaymentRow(payment.tenantId, payment, charge.id);
      return;
    }
    if (["FAILED", "DECLINED", "CANCELLED", "ABANDONED", "TIMEDOUT", "VOID"].includes(charge.status)) {
      await (this.prisma as any).payment.updateMany({
        where: { id: payment.id, status: { not: "SUCCEEDED" } },
        data: { status: "FAILED" },
      });
      this.logger.warn(
        `Tap charge ${charge.id} ${charge.status} for order ${payment.orderId}: ` +
          `${charge.response?.code ?? "?"} ${charge.response?.message ?? ""}`,
      );
      return;
    }
    // INITIATED / IN_PROGRESS — the customer is mid-payment. Nothing to do
    // but wait for the terminal webhook.
    this.logger.log(`Tap charge ${charge.id} still ${charge.status} — no action`);
  }

  /**
   * Pull a Tap-paid order's state back from Tap.
   *
   * The confirmation page calls this when it lands and the order still says
   * unpaid: a redirect that beats the webhook is normal, and a webhook that
   * never arrives at all is the failure this exists to survive.
   */
  async reconcileOrder(orderId: string): Promise<void> {
    const payment = await (this.prisma as any).payment.findFirst({
      where: { orderId, provider: "TAP" },
      orderBy: { createdAt: "desc" },
    });
    if (!payment?.providerChargeId) return;
    if (payment.status === "SUCCEEDED") return;
    const charge = await this.retrieveCharge(payment.providerChargeId);
    await this.settleCharge(charge);
  }

  /**
   * Refund a Tap-paid order in full, reversing the merchant's share too.
   *
   * The brand's destination has to be named or Tap funds the whole refund from
   * the marketplace balance — we would be refunding the customer out of our
   * own money while the merchant kept their cut of a cancelled order.
   */
  async refundOrder(orderId: string, reason = "Order cancelled"): Promise<void> {
    const payment = await (this.prisma as any).payment.findFirst({
      where: { orderId, provider: "TAP", status: "SUCCEEDED" },
      orderBy: { createdAt: "desc" },
    });
    if (!payment?.providerChargeId) return;
    const destinationId = (payment.metadata as any)?.destinationId ?? null;
    const amount = Number(payment.amount);
    const merchantShare = Number(payment.netAmount);
    const out = await this.refundCharge({
      chargeId: payment.providerChargeId,
      amount,
      currency: payment.currency,
      reason,
      destinationId,
      destinationAmount: merchantShare,
    });
    await (this.prisma as any).payment.update({
      where: { id: payment.id },
      data: {
        status: "REFUNDED",
        metadata: { ...(payment.metadata as any), tapRefundId: out.id },
      },
    });
    await this.prisma.order.update({
      where: { id: orderId },
      data: { paymentStatus: "REFUNDED" as any },
    });
    this.logger.log(`Tap refund ${out.id} (${out.status}) for order ${orderId}`);
  }

  // ── internals ─────────────────────────────────────────────────────────────

  /**
   * Our cut, in the order's own currency.
   *
   * Mirrors PaymentsService.computeFeeBreakdownPence, brand-over-location and
   * all — but in decimal units rather than pence, because Tap deals in
   * decimals and a Gulf dinar has three of them. The `* 100` that path uses is
   * exactly the assumption that breaks here.
   */
  private async platformFeeFor(
    order: any,
    total: number,
    currency: string,
  ): Promise<number> {
    const brand = order.brand;
    const src =
      brand?.applicationFeeMode && brand.applicationFeeMode !== "none"
        ? brand
        : order.location;
    const mode = String(src?.applicationFeeMode ?? "none");
    if (mode === "none") return 0;
    const pct =
      mode === "percentage_only" || mode === "fixed_and_percentage"
        ? (Number(src?.applicationFeePercentage ?? 0) / 100) * total
        : 0;
    const fixed =
      mode === "fixed_only" || mode === "fixed_and_percentage"
        ? Number(src?.applicationFeeFixedAmount ?? 0)
        : 0;
    return roundToCurrency(pct + fixed, currency);
  }

  /**
   * Write the Payment row at INITIATED, before the customer has paid.
   *
   * Ahead of the redirect on purpose: the row is what the webhook matches on,
   * and the webhook can land before the customer's browser gets back to us.
   * Creating it on webhook receipt instead would race, and lose the fee
   * breakdown we computed here.
   */
  private async recordPendingPayment(input: {
    tenantId: string;
    order: any;
    charge: TapCharge;
    currency: string;
    total: number;
    platformFee: number;
  }): Promise<void> {
    await (this.prisma as any).payment
      .create({
        data: {
          tenantId: input.tenantId,
          orderId: input.order.id,
          provider: "TAP",
          providerChargeId: input.charge.id,
          amount: input.total,
          currency: input.currency.toLowerCase(),
          status: "PENDING",
          method: "CARD",
          platformFee: input.platformFee,
          processingFee: 0,
          netAmount: roundToCurrency(input.total - input.platformFee, input.currency),
          metadata: {
            tapChargeId: input.charge.id,
            tapStatus: input.charge.status,
            destinationId: input.order.brand?.tapDestinationId ?? null,
          },
        },
      })
      .catch((err: any) => {
        // A duplicate providerChargeId means Tap replayed our idempotency key
        // and handed back the same charge. That is the retry working, not a
        // failure — the existing row is the one the webhook will settle.
        if (String(err?.code) === "P2002") return;
        throw err;
      });
  }
}

/** Tap wants the country code and number as separate fields. Best-effort:
 *  an unparseable number is sent without a country code rather than blocking
 *  a payment over a phone format. */
function parsePhone(raw: string): { country_code: string; number: string } {
  const digits = String(raw).replace(/\D/g, "");
  // +971 50 123 4567 → 971 / 501234567. Gulf codes are three digits, the UK
  // two; longest-first so 971 isn't read as 97.
  for (const cc of ["971", "966", "965", "974", "973", "968", "962", "20", "44"]) {
    if (digits.startsWith(cc)) {
      return { country_code: cc, number: digits.slice(cc.length) };
    }
  }
  return { country_code: "", number: digits };
}

function toUnits(amount: number, currency: string): number {
  return Math.round(amount * 10 ** currencyDecimals(currency));
}
