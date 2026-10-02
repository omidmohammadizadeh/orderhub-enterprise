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
// account, so the existing integration cannot legally be pointed at the Gulf.
// Tap also settles KNET, mada and BENEFIT, which Stripe cannot.
//
// ── The PLATFORM model (what Tap actually gave us, 2026-09-30) ──────────────
//
// The first build (Aug 2026) assumed Tap's MARKETPLACE model: every charge
// landing on OUR account and a `destinations` entry paying the brand out. Tap
// issued us PLATFORM accounts instead, and confirmed the mechanics in writing
// (Batool, 2026-10-01):
//
//   • Three platforms, each with its own id and secret key: COMMERCE
//     (websites — this file's charges), BILLING (invoice/payment links) and
//     APP (our mobile app). Env: TAP_<KIND>_SECRET_KEY + TAP_<KIND>_PLATFORM_ID.
//   • Charges are made with the PLATFORM's secret key and carry
//     `platform.id` + `merchant.id`. The money goes to the BRAND's own Tap
//     merchant, not to us — the Stripe direct-charge shape again.
//   • Our commission rides on the charge as a `destinations` entry naming OUR
//     static wallet (TAP_COMMISSION_DESTINATION_ID), visible to merchants.
//     That is the inverse of the Aug code, where the destination was the
//     merchant and the remainder was ours.
//   • Webhooks are always signed with the platform keys, and one URL serves
//     every merchant.
//   • Onboarding: Lead (v3) → Connect URL → the restaurant does Tap's KYC →
//     Tap posts the new merchant (`merchant_…`) to the URL we gave it.
//
// ── What is verified and what is not ────────────────────────────────────────
//
// Probed against the sandbox (2026-10-01): POST /v3/lead and its response
// shape (`id: "led_…"`, metadata echoed back). From Tap's docs only: the
// Connect request/response (`connect.url`), the merchant-signup payload
// (`id: "merchant_…"`), and `platform`/`merchant`/`destinations` on a charge.
// Tap documents NO signature for the signup webhook, so its URL carries an
// HMAC of the brand id instead — see onboardingSignature.
//
// Refunds deliberately do NOT name our wallet: the merchant funds the whole
// refund and we keep our commission, exactly as the UK's Stripe refunds do
// (no refund_application_fee). Change both together or not at all.

const TAP_API_BASE = "https://api.tap.company";

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
 * Our commission on one charge, as the `destinations` Tap pays it to.
 *
 * One entry naming OUR wallet, at the fee. The rest of the charge stays with
 * the brand's merchant — under the Platform model that is where it lands, not
 * a share we pay out.
 *
 * A zero fee, or one at/over the total, is no destination at all: a zero
 * amount is rejected, and a fee that swallows the whole charge would leave the
 * restaurant nothing for its own food, which is not a thing to guess at
 * mid-checkout.
 */
export function commissionDestinations(input: {
  totalAmount: number;
  platformFee: number;
  currency: string;
  walletId: string | null | undefined;
}): Array<{ id: string; amount: number; currency: string }> {
  if (!input.walletId) return [];
  const total = roundToCurrency(input.totalAmount, input.currency);
  const fee = roundToCurrency(Math.max(0, input.platformFee), input.currency);
  if (!(fee > 0) || fee >= total) return [];
  return [{ id: input.walletId, amount: fee, currency: input.currency }];
}

export type TapPlatformKind = "COMMERCE" | "BILLING" | "APP";
export const TAP_PLATFORM_KINDS: TapPlatformKind[] = ["COMMERCE", "BILLING", "APP"];

export interface TapPlatform {
  kind: TapPlatformKind;
  id: string;
  secretKey: string;
}

/**
 * What's wrong with one platform's env, or null if it's usable / simply unset.
 *
 * Exists because of a real outage of the onboarding button (2026-10-01): a
 * secret pasted into Render from a MASKED display ("sk_test_•••…") made
 * fetch() throw "Cannot convert argument to a ByteString" from inside the
 * Authorization header — a 500 that named no variable. A key is plain ASCII
 * `sk_test_…` / `sk_live_…`; anything else is a paste error, said by name.
 */
export function tapPlatformProblem(
  kind: TapPlatformKind,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const id = env[`TAP_${kind}_PLATFORM_ID`]?.trim();
  const key = env[`TAP_${kind}_SECRET_KEY`]?.trim();
  if (!id && !key) return null;
  if (!key) return `TAP_${kind}_SECRET_KEY is missing (TAP_${kind}_PLATFORM_ID is set).`;
  if (!id) return `TAP_${kind}_PLATFORM_ID is missing (TAP_${kind}_SECRET_KEY is set).`;
  if (/[^\x21-\x7e]/.test(key)) {
    return `TAP_${kind}_SECRET_KEY contains characters a key can't have (e.g. "•") — it was probably copied from a masked display. Paste the full key from Tap's email.`;
  }
  if (!/^sk_(test|live)_[A-Za-z0-9_]+$/.test(key)) {
    return `TAP_${kind}_SECRET_KEY doesn't look like a Tap secret key (it should start sk_test_ or sk_live_).`;
  }
  if (!/^[A-Za-z0-9_]+$/.test(id)) {
    return `TAP_${kind}_PLATFORM_ID doesn't look like a Tap platform id (e.g. ${kind.toLowerCase()}_platform_…).`;
  }
  return null;
}

/**
 * One platform's id + secret key from the environment, or null when either is
 * missing or malformed — half a platform is no platform, and a charge with
 * the right key but no platform id would be routed as if we were the
 * merchant. tapPlatformProblem says why.
 *
 * The pre-Platform `TAP_SECRET_KEY` is deliberately NOT a fallback: it was a
 * marketplace key, and treating it as the commerce platform would send charges
 * to the wrong account type.
 */
export function tapPlatformFromEnv(
  kind: TapPlatformKind,
  env: NodeJS.ProcessEnv = process.env,
): TapPlatform | null {
  const id = env[`TAP_${kind}_PLATFORM_ID`]?.trim();
  const secretKey = env[`TAP_${kind}_SECRET_KEY`]?.trim();
  if (!id || !secretKey) return null;
  if (tapPlatformProblem(kind, env)) return null;
  return { kind, id, secretKey };
}

/**
 * What Tap's merchant-signup webhook URL is signed with.
 *
 * Tap documents no signature for that webhook, and its body carries the
 * merchant id we are about to route a brand's money to — so an unauthenticated
 * URL would let anyone point a brand's card takings at their own merchant. The
 * URL instead carries HMAC(brandId); only Tap ever sees it, and it can't be
 * forged for another brand. Derived, not stored, so it never sits in a brand
 * row the dashboard reads back.
 */
export function onboardingSignature(brandId: string, secret: string): string {
  return createHmac("sha256", secret).update(`tap-onboarding:${brandId}`).digest("hex");
}

/**
 * Pull the new merchant id out of Tap's signup webhook. Two documented shapes:
 * the merchant object itself (`id: "merchant_…"`) and the board notification
 * (`merchant: { id }`). Anything else is not a merchant id, and guessing one is
 * how a brand's money ends up on the wrong account.
 */
export function merchantIdFromSignup(body: any): string | null {
  const candidates = [body?.id, body?.merchant?.id];
  for (const c of candidates) {
    if (typeof c === "string" && /^merchant_[A-Za-z0-9]+$/.test(c)) return c;
  }
  return null;
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

  platform(kind: TapPlatformKind): TapPlatform | null {
    return tapPlatformFromEnv(kind);
  }

  private configuredPlatforms(): TapPlatform[] {
    return TAP_PLATFORM_KINDS.map((k) => this.platform(k)).filter(
      (p): p is TapPlatform => !!p,
    );
  }

  /** Our wallet on Tap — the destination our commission is paid into. */
  private get commissionWalletId(): string | null {
    return process.env.TAP_COMMISSION_DESTINATION_ID?.trim() || null;
  }

  private get apiHost(): string {
    // TAP_API_BASE used to include /v2. Accept either, and add the version
    // per call — leads and Connect are v3, charges and refunds v2.
    return (process.env.TAP_API_BASE?.trim() || TAP_API_BASE)
      .replace(/\/+$/, "")
      .replace(/\/v\d+$/, "");
  }

  /** Whether online card payments can be taken at all. Checked before routing
   *  a shop to Tap, so a missing key is a clear refusal at checkout rather
   *  than a 500 mid-pay. */
  configured(): boolean {
    return !!this.platform("COMMERCE");
  }

  private async call<T>(
    key: string,
    path: string,
    init: { method: string; body?: unknown },
  ): Promise<T> {
    let res: Response;
    try {
      res = await fetch(`${this.apiHost}${path}`, {
        method: init.method,
        headers: {
          Authorization: `Bearer ${key}`,
          "Content-Type": "application/json",
          accept: "application/json",
        },
        ...(init.body ? { body: JSON.stringify(init.body) } : {}),
        signal: AbortSignal.timeout(15_000),
      });
    } catch (err: any) {
      // Never reached Tap: a timeout, DNS, or a header fetch() refuses to
      // send. A bare TypeError here used to surface as a nameless 500.
      this.logger.error(`Tap ${init.method} ${path} didn't reach Tap: ${err?.message ?? err}`);
      throw new BadRequestException(
        "Couldn't reach Tap just now. Please try again in a moment.",
      );
    }
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
   * Start a hosted card payment for one order, on the COMMERCE platform.
   *
   * Hosted rather than embedded: `src_all` renders Tap's own page with every
   * method the merchant has enabled — Apple Pay, and KNET/mada/BENEFIT where
   * they apply — each with its own redirect and 3-D Secure flow.
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
    const platform = this.platform("COMMERCE");
    if (!platform) throw new BadRequestException("Card payments aren't configured.");

    const order = await this.prisma.order.findFirst({
      where: { id: params.orderId, tenantId: params.tenantId },
      include: {
        location: { select: { id: true, name: true, country: true, currency: true } },
        brand: {
          select: {
            id: true,
            name: true,
            tapMerchantId: true,
            applicationFeeMode: true,
            applicationFeeFixedAmount: true,
            applicationFeePercentage: true,
          } as any,
        } as any,
      },
    });
    if (!order) throw new NotFoundException("Order not found");
    const brand = (order as any).brand;
    const merchantId = brand?.tapMerchantId;
    if (!merchantId) {
      // Deliberately specific. "Payment failed" here sends an operator to
      // check their card details when what's missing is a Tap onboarding step
      // only they can complete.
      throw new BadRequestException(
        "This brand hasn't finished Tap onboarding — it has no Tap merchant account yet, so there's nowhere for the money to go. Choose Cash, or contact the restaurant.",
      );
    }

    const currency = (
      (order as any).location?.currency ||
      currencyForCountry((order as any).location?.country)
    ).toUpperCase();
    const basket = roundToCurrency(Number(order.total), currency);
    const { platformFee, customerSurcharge } = this.feeBreakdown(
      order,
      basket,
      currency,
    );
    // What the customer is actually charged. The fixed part of the fee is a
    // surcharge on top of the basket, so it has to be IN the amount as well as
    // in our cut — charging only the basket would quietly take it out of the
    // restaurant instead, which is the opposite of what the setting means.
    const charged = roundToCurrency(basket + customerSurcharge, currency);
    const destinations = commissionDestinations({
      totalAmount: charged,
      platformFee,
      currency,
      walletId: this.commissionWalletId,
    });

    const charge = await this.call<TapCharge>(platform.secretKey, "/v2/charges", {
      method: "POST",
      body: {
        amount: charged,
        currency,
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
        // Tap's hosted page shows the description, and it is the only place
        // the customer can see why they are being charged more than their
        // basket — a charge has no line items.
        description:
          `${brand?.name ?? (order as any).location?.name ?? "Order"} — ${order.displayId ?? order.id}` +
          (customerSurcharge > 0
            ? ` (incl. ${customerSurcharge.toFixed(currencyDecimals(currency))} service charge)`
            : ""),
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
        // The Platform model: whose money this is (the brand's merchant) and
        // which of our platforms took it.
        platform: { id: platform.id },
        merchant: { id: merchantId },
        ...(destinations.length ? { destinations: { destination: destinations } } : {}),
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

    // What we actually take is what rode on the charge — if no commission
    // destination went out, we earned nothing on it, and the Payment row must
    // not claim otherwise.
    const takenFee = destinations.reduce((sum, d) => sum + d.amount, 0);
    await this.recordPendingPayment({
      tenantId: params.tenantId,
      order,
      charge,
      currency,
      charged,
      platformFee: roundToCurrency(takenFee, currency),
      merchantId,
      platformKind: platform.kind,
    });

    return { chargeId: charge.id, redirectUrl: url, amount: charged, currency };
  }

  /** Read a charge back from Tap. Used to reconcile an order whose webhook
   *  never arrived — the customer is back on the confirmation page and Tap is
   *  the only thing that knows whether their money moved. */
  async retrieveCharge(
    chargeId: string,
    kind: TapPlatformKind = "COMMERCE",
  ): Promise<TapCharge> {
    const platform = this.platform(kind);
    if (!platform) throw new BadRequestException("Card payments aren't configured.");
    return this.call<TapCharge>(
      platform.secretKey,
      `/v2/charges/${encodeURIComponent(chargeId)}`,
      { method: "GET" },
    );
  }

  /**
   * Refund a Tap charge, in full or in part.
   *
   * No `destinations`: under the Platform model the money sits with the
   * merchant, so the refund comes out of their balance and our commission
   * stays ours — the same as a UK Stripe refund. `commissionRefund` hands our
   * cut back as well, for the case where that is the agreed outcome.
   */
  async refundCharge(params: {
    chargeId: string;
    amount: number;
    currency: string;
    reason: string;
    kind?: TapPlatformKind;
    commissionRefund?: number;
  }): Promise<{ id: string; status: string }> {
    const platform = this.platform(params.kind ?? "COMMERCE");
    if (!platform) throw new BadRequestException("Card payments aren't configured.");
    const currency = params.currency.toUpperCase();
    const amount = roundToCurrency(params.amount, currency);
    const wallet = this.commissionWalletId;
    const back =
      wallet && params.commissionRefund != null
        ? roundToCurrency(params.commissionRefund, currency)
        : 0;
    return this.call<{ id: string; status: string }>(platform.secretKey, "/v2/refunds", {
      method: "POST",
      body: {
        charge_id: params.chargeId,
        amount,
        currency,
        reason: params.reason,
        ...(back > 0
          ? { destinations: { destination: [{ id: wallet, amount: back, currency }] } }
          : {}),
        reference: { idempotent: `rf_${params.chargeId}_${toUnits(amount, currency)}` },
      },
    });
  }

  /**
   * Verify a charge/refund webhook against the `hashstring` header.
   *
   * Signed with a PLATFORM's secret key (Tap, in writing). We have up to
   * three and the body doesn't say which one, so any configured platform key
   * that matches is accepted. An unverified body is not a payment: posting a
   * CAPTURED charge to this public URL is otherwise all it would take to mark
   * any order paid.
   */
  verifyWebhook(body: TapSignable, hashstring: string | undefined): boolean {
    if (!hashstring) return false;
    const signed = tapHashString(body);
    return this.configuredPlatforms().some((p) =>
      signaturesMatch(
        createHmac("sha256", p.secretKey).update(signed).digest("hex"),
        hashstring,
      ),
    );
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
   * because a customer whose card was declined usually tries again.
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
    const charge = await this.retrieveCharge(
      payment.providerChargeId,
      platformKindOf(payment),
    );
    await this.settleCharge(charge);
  }

  /** Refund a Tap-paid order in full. The merchant funds it; see refundCharge. */
  async refundOrder(orderId: string, reason = "Order cancelled"): Promise<void> {
    const payment = await (this.prisma as any).payment.findFirst({
      where: { orderId, provider: "TAP", status: "SUCCEEDED" },
      orderBy: { createdAt: "desc" },
    });
    if (!payment?.providerChargeId) return;
    const out = await this.refundCharge({
      chargeId: payment.providerChargeId,
      amount: Number(payment.amount),
      currency: payment.currency,
      reason,
      kind: platformKindOf(payment),
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

  /**
   * What an admin needs to see to know Tap will work — without exposing a
   * single secret. Rendered on the Payments page above the brand rows.
   */
  status(): {
    platforms: Array<{ kind: TapPlatformKind; configured: boolean; mode: "test" | "live" | null; problem: string | null }>;
    commissionWallet: boolean;
    ready: boolean;
  } {
    const platforms = TAP_PLATFORM_KINDS.map((kind) => {
      const p = this.platform(kind);
      return {
        kind,
        configured: !!p,
        mode: p ? (p.secretKey.startsWith("sk_live_") ? ("live" as const) : ("test" as const)) : null,
        problem: tapPlatformProblem(kind),
      };
    });
    return {
      platforms,
      commissionWallet: !!this.commissionWalletId,
      ready: !!this.platform("COMMERCE"),
    };
  }

  /** Refuse loudly, by variable name, when a platform's env is broken. */
  private assertPlatformsSane(): void {
    const problems = TAP_PLATFORM_KINDS.map((k) => tapPlatformProblem(k)).filter(Boolean);
    if (problems.length) {
      this.logger.error(`Tap configuration: ${problems.join(" | ")}`);
      throw new BadRequestException(`Tap is misconfigured: ${problems.join(" ")}`);
    }
  }

  // ── Onboarding: Lead → Connect → merchant ─────────────────────────────────

  private get onboardingSecret(): string | null {
    return (
      process.env.TAP_ONBOARDING_SECRET?.trim() ||
      this.platform("COMMERCE")?.secretKey ||
      null
    );
  }

  /** The URL Tap posts the new merchant to for one brand. */
  onboardingWebhookUrl(brandId: string): string {
    const secret = this.onboardingSecret;
    if (!secret) throw new BadRequestException("Tap isn't configured.");
    const api = (process.env.API_URL ?? "").replace(/\/+$/, "");
    return `${api}/v1/payments/tap/onboarding/${encodeURIComponent(brandId)}/${onboardingSignature(brandId, secret)}`;
  }

  verifyOnboardingSignature(brandId: string, sig: string): boolean {
    const secret = this.onboardingSecret;
    if (!secret) return false;
    return signaturesMatch(onboardingSignature(brandId, secret), sig ?? "");
  }

  /**
   * Generate (or regenerate) the Tap sign-up link for a brand.
   *
   * One lead per brand, listing every platform we have, so the restaurant does
   * KYC once and its merchant can be charged from the website, payment links
   * and the app alike — Tap's guidance is to onboard a merchant under each
   * platform it will use. An open lead is reused; Tap expires them after 30
   * days, so a failure to connect it falls through to a fresh lead.
   */
  async startOnboarding(
    tenantId: string,
    brandId: string,
  ): Promise<{ connectUrl: string; leadId: string; status: string }> {
    const brand = await this.prisma.brand.findFirst({
      where: { id: brandId, tenantId, deletedAt: null },
    });
    if (!brand) throw new NotFoundException("Brand not found");
    const b = brand as any;
    if (b.tapMerchantId) {
      throw new BadRequestException(
        "This brand already has a Tap merchant account. Clear it first if you really mean to onboard again.",
      );
    }
    this.assertPlatformsSane();
    const platforms = this.configuredPlatforms();
    if (!platforms.length) throw new BadRequestException("Tap isn't configured.");

    const postUrl = this.onboardingWebhookUrl(brandId);
    const web = (process.env.WEB_URL ?? "https://www.orderhubsolutions.com").replace(/\/+$/, "");
    const redirectUrl = `${web}/dashboard/payments?tapOnboarded=${encodeURIComponent(brandId)}`;

    let leadId: string | null = b.tapLeadId ?? null;
    let connectUrl: string | null = null;
    if (leadId) {
      connectUrl = await this.connectUrlFor(platforms, leadId, postUrl, redirectUrl).catch(
        (err) => {
          this.logger.warn(`Tap lead ${leadId} couldn't be reconnected (${err.message}) — starting a new one`);
          return null;
        },
      );
    }
    if (!connectUrl) {
      leadId = await this.createLead(platforms, b, postUrl);
      connectUrl = await this.connectUrlFor(platforms, leadId, postUrl, redirectUrl);
    }

    await this.prisma.brand.update({
      where: { id: brandId },
      data: {
        tapLeadId: leadId,
        tapConnectUrl: connectUrl,
        tapOnboardingStatus: "link_sent",
      } as any,
    });
    return { connectUrl, leadId: leadId!, status: "link_sent" };
  }

  /**
   * Try each platform key in turn. In the sandbox (2026-10-01) the same lead
   * call was refused by one platform's key ("Api_key_unauthorised") and
   * accepted by another's, with no pattern documented — so one refusal is not
   * an answer.
   */
  private async withAnyPlatform<T>(
    platforms: TapPlatform[],
    fn: (p: TapPlatform) => Promise<T>,
  ): Promise<T> {
    let last: unknown;
    for (const p of platforms) {
      try {
        return await fn(p);
      } catch (err) {
        last = err;
      }
    }
    throw last instanceof Error ? last : new BadRequestException("Tap refused the request.");
  }

  private async createLead(platforms: TapPlatform[], brand: any, postUrl: string): Promise<string> {
    // Tap wants a brand name of at least three characters.
    const name = String(brand.name ?? "").trim().padEnd(3, ".");
    const body = {
      country: String(brand.country || "AE").toUpperCase(),
      brand: { name: [{ text: name, lang: "en" }] },
      merchant: { platforms: platforms.map((p) => ({ id: p.id })) },
      // Echoed back on the lead — how a lead in Tap OS is traced to a brand.
      metadata: { brandId: brand.id, tenantId: brand.tenantId },
      post: { url: postUrl },
    };
    const lead = await this.withAnyPlatform(platforms, (p) =>
      this.call<{ id: string }>(p.secretKey, "/v3/lead", { method: "POST", body }),
    );
    if (!lead?.id) throw new BadRequestException("Tap didn't return a lead id.");
    return lead.id;
  }

  private async connectUrlFor(
    platforms: TapPlatform[],
    leadId: string,
    postUrl: string,
    redirectUrl: string,
  ): Promise<string> {
    const res = await this.withAnyPlatform(platforms, (p) =>
      this.call<{ connect?: { url?: string } }>(p.secretKey, "/v3/connect", {
        method: "POST",
        body: {
          scope: "merchant",
          data: ["operation", "brand", "entity", "merchant"],
          lead: { id: leadId },
          board: { editable: true, display: true },
          redirect: { url: redirectUrl },
          post: { url: postUrl },
          webhook: { url: postUrl },
          interface: { locale: "en", direction: "ltr", edges: "curved" },
        },
      }),
    );
    const url = res?.connect?.url;
    if (!url) throw new BadRequestException("Tap didn't return a sign-up link.");
    return url;
  }

  /**
   * Tap's merchant-signup webhook, already authenticated by its URL signature.
   *
   * Takes ONLY the merchant id. The payload also carries the new merchant's
   * own API keys (`operator.api_credentials`) — we charge with our platform
   * keys, so we have no use for them, and storing a merchant's live secret is
   * a liability with no upside. Never log the body for the same reason.
   */
  async completeOnboarding(brandId: string, body: any): Promise<boolean> {
    const merchantId = merchantIdFromSignup(body);
    if (!merchantId) {
      this.logger.log(
        `Tap onboarding post for brand ${brandId} carried no merchant id (keys: ${Object.keys(body ?? {}).join(",")}) — ignoring`,
      );
      return false;
    }
    const echoed = body?.metadata?.brandId;
    if (echoed && echoed !== brandId) {
      this.logger.warn(`Tap onboarding post for brand ${brandId} names brand ${echoed} — refusing`);
      return false;
    }
    const brand = await this.prisma.brand.findFirst({ where: { id: brandId } });
    if (!brand) return false;
    const existing = (brand as any).tapMerchantId;
    if (existing && existing !== merchantId) {
      // Never silently move a trading brand's money to a different account.
      this.logger.warn(
        `Tap onboarding post for brand ${brandId} names ${merchantId} but it already has ${existing} — not overwriting`,
      );
      return false;
    }
    await this.prisma.brand.update({
      where: { id: brandId },
      data: { tapMerchantId: merchantId, tapOnboardingStatus: "completed" } as any,
    });
    this.logger.log(`Tap onboarding complete for brand ${brandId}: ${merchantId}`);
    return true;
  }

  /**
   * Set or clear a brand's Tap merchant by hand — for a merchant onboarded in
   * Tap OS rather than through our link, or a webhook that never arrived.
   * Admin-only at the route; the format check stops a pasted lead/brand id
   * (`led_…`, `brd_…`) being taken for a merchant.
   */
  async setMerchantId(
    tenantId: string,
    brandId: string,
    merchantId: string | null,
  ): Promise<{ tapMerchantId: string | null; tapOnboardingStatus: string }> {
    const brand = await this.prisma.brand.findFirst({
      where: { id: brandId, tenantId, deletedAt: null },
    });
    if (!brand) throw new NotFoundException("Brand not found");
    const id = (merchantId ?? "").trim() || null;
    if (id && !/^merchant_[A-Za-z0-9]+$/.test(id)) {
      throw new BadRequestException(
        "That isn't a Tap merchant id — it should start with merchant_ (Tap OS → Merchants).",
      );
    }
    const status = id
      ? "completed"
      : (brand as any).tapLeadId
        ? "link_sent"
        : "not_started";
    await this.prisma.brand.update({
      where: { id: brandId },
      data: { tapMerchantId: id, tapOnboardingStatus: status } as any,
    });
    return { tapMerchantId: id, tapOnboardingStatus: status };
  }

  // ── internals ─────────────────────────────────────────────────────────────

  /**
   * Split the fee the way the UK already does, in the order's own currency.
   *
   * Two different things come out of one config, and they are NOT the same
   * money:
   *
   *   • the FIXED part is a visible surcharge ADDED to the customer's bill —
   *     7.75% + AED 2 on a 100 order means the customer is charged 102;
   *   • the PERCENTAGE part is silent, taken out of the restaurant's share.
   *
   * Same arithmetic as computeFeeBreakdownPence in PaymentsService, and it has
   * to stay the same or the identical brand config would mean different money
   * either side of the Gulf.
   *
   * Decimal units, not pence: the `* 100` that path uses is exactly the
   * assumption that breaks on a three-decimal dinar.
   *
   * With no commission wallet configured there is nowhere for our fee to go,
   * so there is no fee at all — not even the customer surcharge, which would
   * otherwise be charged to the customer and land with the restaurant.
   */
  private feeBreakdown(
    order: any,
    basket: number,
    currency: string,
  ): { platformFee: number; customerSurcharge: number } {
    if (!this.commissionWalletId) {
      return { platformFee: 0, customerSurcharge: 0 };
    }
    const brand = order.brand;
    const src =
      brand?.applicationFeeMode && brand.applicationFeeMode !== "none"
        ? brand
        : order.location;
    const mode = String(src?.applicationFeeMode ?? "none");
    if (mode === "none") return { platformFee: 0, customerSurcharge: 0 };

    const usesFixed = mode === "fixed_only" || mode === "fixed_and_percentage";
    const usesPct = mode === "percentage_only" || mode === "fixed_and_percentage";
    const fixed = usesFixed ? Number(src?.applicationFeeFixedAmount ?? 0) : 0;
    const pct = usesPct
      ? basket * (Number(src?.applicationFeePercentage ?? 0) / 100)
      : 0;

    return {
      platformFee: roundToCurrency(fixed + pct, currency),
      customerSurcharge: roundToCurrency(fixed, currency),
    };
  }

  /**
   * Write the Payment row at INITIATED, before the customer has paid.
   *
   * Ahead of the redirect on purpose: the row is what the webhook matches on,
   * and the webhook can land before the customer's browser gets back to us.
   */
  private async recordPendingPayment(input: {
    tenantId: string;
    order: any;
    charge: TapCharge;
    currency: string;
    /** What the customer is charged — basket PLUS any fixed surcharge. */
    charged: number;
    platformFee: number;
    merchantId: string;
    platformKind: TapPlatformKind;
  }): Promise<void> {
    await (this.prisma as any).payment
      .create({
        data: {
          tenantId: input.tenantId,
          orderId: input.order.id,
          provider: "TAP",
          providerChargeId: input.charge.id,
          amount: input.charged,
          currency: input.currency.toLowerCase(),
          status: "PENDING",
          method: "CARD",
          platformFee: input.platformFee,
          processingFee: 0,
          // What the restaurant's merchant keeps of the charge.
          netAmount: roundToCurrency(
            input.charged - input.platformFee,
            input.currency,
          ),
          metadata: {
            tapChargeId: input.charge.id,
            tapStatus: input.charge.status,
            tapMerchantId: input.merchantId,
            tapPlatform: input.platformKind,
            commissionWalletId: input.platformFee > 0 ? this.commissionWalletId : null,
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

/** Which platform took a payment — charges are read and refunded with that
 *  platform's key. Rows from before the Platform model have none: COMMERCE. */
function platformKindOf(payment: any): TapPlatformKind {
  const k = (payment?.metadata as any)?.tapPlatform;
  return TAP_PLATFORM_KINDS.includes(k) ? k : "COMMERCE";
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
