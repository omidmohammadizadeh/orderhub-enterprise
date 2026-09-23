import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { createHash, randomBytes, timingSafeEqual } from "crypto";
import { currencyForCountry } from "@orderhub/shared";
import { PrismaService } from "../../../infrastructure/database/prisma.service";
import { CredentialEncryptionService } from "../../integrations/credential-encryption.service";
import { PaymentsService } from "../payments.service";
import {
  DojoApiClient,
  DojoApiError,
  DojoPaymentIntent,
  DojoTerminalSessionStatus,
  dojoKeyEnvironment,
} from "./dojo-api.client";

// Dojo card machines — the second card-present provider beside Stripe
// Terminal (see terminal.service.ts).
//
// ── How it differs from Stripe, and why that shapes this file ──────────────
//
// Dojo has no Connect: each restaurant has its OWN Dojo account and API key,
// and the money settles straight to them. So there is no application fee to
// take here and no platform account in the path — we are the EPOS driving
// their machine, nothing more. The key is stored per LOCATION (Dojo issues
// keys per location account), encrypted with the same envelope the delivery
// integrations use.
//
// ── The one rule for money ──────────────────────────────────────────────────
//
// We never settle an order on anybody's say-so. The POS poll, the webhook and
// Pay at Table's record-payment call all end in verifyAndSettle(), which
// fetches the payment intent from Dojo WITH THE SHOP'S OWN KEY and requires
// it to be Captured (or Authorized, for Pay at Table's pre-capture record)
// for exactly the amount on our Payment row. A forged webhook or a leaked
// Pay-at-Table password can therefore only ever make us look something up.
//
// ── Sandbox ─────────────────────────────────────────────────────────────────
//
// A sk_sandbox_ key drives Dojo's sandbox terminals and moves no money, yet a
// "Captured" sandbox payment still settles the order PAID. That is the same
// power as the existing "mark paid manually" button every manager already
// has, so it isn't a new hole — but every sandbox Payment is tagged
// `sandbox: true` and the settings page shows the environment loudly.

export interface DojoTerminalConfig {
  id: string; // tm_…
  label: string;
}

export interface DojoPayAtTableConfig {
  enabled: boolean;
  username: string;
  /** sha256 of the Basic-auth password we registered with Dojo. The
   *  plaintext is sent to Dojo once and never stored. */
  passwordHash: string;
  registeredAt: string;
}

export interface DojoLocationConfig {
  credentials: Record<string, unknown>; // encrypted { apiKey }
  keyHint: string;
  environment: "sandbox" | "production";
  connectedAt: string;
  terminals: DojoTerminalConfig[];
  webhookSubscriptionId?: string | null;
  payAtTable?: DojoPayAtTableConfig | null;
}

/** Session states that mean "over, and nothing was taken". */
const FAILED_SESSION: ReadonlySet<DojoTerminalSessionStatus> = new Set([
  "Canceled",
  "Declined",
  "Expired",
  "SignatureVerificationRejected",
]);

/** Pay at Table capabilities we implement (see dojo-epos.controller.ts). */
export const PAY_AT_TABLE_CAPABILITIES = [
  "SearchOrders",
  "GetOrderById",
  "GetOrderBillById",
  "RecordOrderPaymentById",
  "CreateOrderLock",
  "DeleteOrderLock",
  "ExtendOrderLock",
  "SearchTables",
  "ListAreas",
];

export function hashSecret(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function safeEqualHex(a: string, b: string): boolean {
  const ab = Buffer.from(a, "hex");
  const bb = Buffer.from(b, "hex");
  return ab.length === bb.length && ab.length > 0 && timingSafeEqual(ab, bb);
}

@Injectable()
export class DojoService {
  private readonly logger = new Logger(DojoService.name);

  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
    private readonly payments: PaymentsService,
    private readonly crypto: CredentialEncryptionService,
  ) {}

  // Overridable in tests.
  protected makeClient(apiKey: string): DojoApiClient {
    return new DojoApiClient(apiKey, {
      softwareHouseId: this.config.get<string>("DOJO_SOFTWARE_HOUSE_ID") ?? null,
      resellerId:
        this.config.get<string>("DOJO_RESELLER_ID") ??
        this.config.get<string>("DOJO_SOFTWARE_HOUSE_ID") ??
        null,
    });
  }

  private publicApiBase(): string {
    return (
      this.config.get<string>("API_PUBLIC_URL") ??
      this.config.get<string>("PUBLIC_API_URL") ??
      "https://api.orderhubsolutions.com"
    ).replace(/\/+$/, "") + "/api";
  }

  // ── Config (Location.settings.dojo — no schema change) ────────────────────

  async loadLocation(tenantId: string, locationId: string) {
    const loc = await this.prisma.location.findFirst({
      where: { id: locationId, brand: { tenantId }, deletedAt: null },
      select: { id: true, name: true, country: true, settings: true, brand: { select: { tenantId: true } } },
    });
    if (!loc) throw new NotFoundException("Location not found");
    return loc;
  }

  configFrom(settings: unknown): DojoLocationConfig | null {
    const d = ((settings ?? {}) as Record<string, any>).dojo;
    if (!d || typeof d !== "object" || !d.credentials) return null;
    return {
      ...d,
      terminals: Array.isArray(d.terminals) ? d.terminals : [],
    } as DojoLocationConfig;
  }

  private async saveConfig(locationId: string, cfg: DojoLocationConfig | null) {
    // Re-read inside the write so a concurrent settings edit elsewhere (the
    // Stripe reader list lives in the same JSON) isn't clobbered by a stale
    // copy we loaded earlier.
    const fresh = await this.prisma.location.findUnique({
      where: { id: locationId },
      select: { settings: true },
    });
    const settings = { ...((fresh?.settings ?? {}) as Record<string, any>) };
    if (cfg) settings.dojo = cfg;
    else delete settings.dojo;
    await this.prisma.location.update({
      where: { id: locationId },
      data: { settings: settings as any },
    });
  }

  apiKeyFrom(cfg: DojoLocationConfig): string {
    const creds = this.crypto.decrypt(cfg.credentials) as { apiKey?: string };
    if (!creds?.apiKey) {
      throw new BadRequestException("Dojo credentials are unreadable — reconnect Dojo for this location.");
    }
    return creds.apiKey;
  }

  clientFor(cfg: DojoLocationConfig): DojoApiClient {
    return this.makeClient(this.apiKeyFrom(cfg));
  }

  private async requireConfig(tenantId: string, locationId: string) {
    const loc = await this.loadLocation(tenantId, locationId);
    const cfg = this.configFrom(loc.settings);
    if (!cfg) throw new BadRequestException("Dojo isn't connected at this location.");
    return { loc, cfg };
  }

  // ── Connect / disconnect ──────────────────────────────────────────────────

  async status(tenantId: string, locationId: string) {
    const loc = await this.loadLocation(tenantId, locationId);
    const cfg = this.configFrom(loc.settings);
    if (!cfg) {
      return {
        connected: false as const,
        partnerIdsConfigured: !!this.config.get<string>("DOJO_SOFTWARE_HOUSE_ID"),
      };
    }
    let terminals: Array<DojoTerminalConfig & { tid: string | null; status: string }> = [];
    let terminalsError: string | null = null;
    try {
      const live = await this.clientFor(cfg).listTerminals();
      terminals = live.map((t) => ({
        id: t.id,
        tid: t.properties?.tid ?? null,
        status: t.status,
        label:
          cfg.terminals.find((c) => c.id === t.id)?.label ??
          (t.properties?.tid ? `Dojo ${t.properties.tid}` : "Dojo card machine"),
      }));
    } catch (err: any) {
      terminalsError = err?.message ?? "Couldn't reach Dojo";
      terminals = cfg.terminals.map((t) => ({ ...t, tid: null, status: "Unknown" }));
    }
    return {
      connected: true as const,
      environment: cfg.environment,
      keyHint: cfg.keyHint,
      connectedAt: cfg.connectedAt,
      terminals,
      terminalsError,
      webhook: !!cfg.webhookSubscriptionId,
      partnerIdsConfigured: !!this.config.get<string>("DOJO_SOFTWARE_HOUSE_ID"),
      payAtTable: cfg.payAtTable
        ? { enabled: cfg.payAtTable.enabled, registeredAt: cfg.payAtTable.registeredAt }
        : { enabled: false, registeredAt: null },
    };
  }

  async connect(tenantId: string, locationId: string, rawKey: string) {
    const apiKey = (rawKey ?? "").trim();
    const environment = dojoKeyEnvironment(apiKey);
    if (!environment) {
      throw new BadRequestException(
        "That isn't a Dojo secret key — it should start with sk_prod_ (or sk_sandbox_ for testing).",
      );
    }
    const loc = await this.loadLocation(tenantId, locationId);
    const client = this.makeClient(apiKey);

    // Prove the key works before saving it. /terminals is the call this
    // integration lives on, and it also proves the partner headers are right.
    let terminals;
    try {
      terminals = await client.listTerminals();
    } catch (err: any) {
      if (err instanceof DojoApiError && (err.status === 401 || err.status === 403)) {
        throw new BadRequestException(
          "Dojo refused that key. Check it's the SECRET key for this location, with terminal access enabled.",
        );
      }
      throw new BadRequestException(`Couldn't reach Dojo: ${err?.message ?? "unknown error"}`);
    }

    const previous = this.configFrom(loc.settings);
    const cfg: DojoLocationConfig = {
      credentials: this.crypto.encrypt({ apiKey }),
      keyHint: `…${apiKey.slice(-4)}`,
      environment,
      connectedAt: new Date().toISOString(),
      terminals: terminals.map((t) => ({
        id: t.id,
        label:
          previous?.terminals.find((p) => p.id === t.id)?.label ??
          (t.properties?.tid ? `Dojo ${t.properties.tid}` : "Dojo card machine"),
      })),
      webhookSubscriptionId: null,
      // A new key may be a different Dojo account; Pay at Table was
      // registered against the old one, so it must be re-enabled.
      payAtTable: null,
    };

    // Best-effort webhook. The POS polls anyway, so a failure here costs
    // nothing but a little latency — never block connecting on it.
    //
    // The event NAMES come from Dojo rather than from us: subscribing to a
    // name this account doesn't offer fails the whole call with "one or more
    // validation errors occurred", which is what a guessed
    // "payment_intent.status_updated" got.
    try {
      const catalogue = await client.listWebhookEventTypes().catch(() => []);
      const events = catalogue
        .flatMap((g) => g?.events ?? [])
        .filter((e) => typeof e === "string" && e.startsWith("payment_intent"));
      if (events.length) {
        const sub = await client.subscribeWebhook(
          `${this.publicApiBase()}/v1/payments/dojo/webhook/${loc.id}`,
          events,
        );
        cfg.webhookSubscriptionId = sub?.id ?? null;
        this.logger.log(`Dojo webhook subscribed for ${loc.id}: ${events.join(", ")}`);
      } else {
        this.logger.warn(`Dojo offered no payment_intent webhook events for ${loc.id} — polling only`);
      }
    } catch (err: any) {
      this.logger.warn(`Dojo webhook subscribe failed for location ${loc.id}: ${err?.message}`);
    }

    await this.saveConfig(loc.id, cfg);
    this.logger.log(
      `Dojo connected at location ${loc.id} (${environment}, ${terminals.length} terminal(s))`,
    );
    return this.status(tenantId, locationId);
  }

  async disconnect(tenantId: string, locationId: string) {
    const loc = await this.loadLocation(tenantId, locationId);
    const cfg = this.configFrom(loc.settings);
    if (cfg?.webhookSubscriptionId) {
      await this.clientFor(cfg)
        .deleteWebhook(cfg.webhookSubscriptionId)
        .catch(() => undefined);
    }
    await this.saveConfig(loc.id, null);
    return { connected: false };
  }

  async renameTerminal(tenantId: string, locationId: string, terminalId: string, label: string) {
    const { loc, cfg } = await this.requireConfig(tenantId, locationId);
    const clean = (label ?? "").trim().slice(0, 40);
    if (!clean) throw new BadRequestException("Give the machine a name");
    const others = cfg.terminals.filter((t) => t.id !== terminalId);
    cfg.terminals = [...others, { id: terminalId, label: clean }];
    await this.saveConfig(loc.id, cfg);
    return { ok: true };
  }

  // ── Pay at Table registration ─────────────────────────────────────────────

  async enablePayAtTable(tenantId: string, locationId: string) {
    const { loc, cfg } = await this.requireConfig(tenantId, locationId);
    const username = `orderhub-${loc.id}`;
    // Fresh password every time it's (re-)enabled: Dojo's PUT replaces the
    // registration, so rotating is free and an old leaked one dies here.
    const password = randomBytes(24).toString("base64url");
    try {
      await this.clientFor(cfg).registerRestIntegration({
        url: `${this.publicApiBase()}/v1/dojo/epos/${loc.id}`,
        username,
        password,
        capabilities: PAY_AT_TABLE_CAPABILITIES,
      });
    } catch (err: any) {
      throw new BadRequestException(
        `Dojo didn't accept the Pay at Table registration: ${err?.message ?? "unknown error"}`,
      );
    }
    cfg.payAtTable = {
      enabled: true,
      username,
      passwordHash: hashSecret(password),
      registeredAt: new Date().toISOString(),
    };
    await this.saveConfig(loc.id, cfg);
    this.logger.log(`Dojo Pay at Table enabled at location ${loc.id}`);
    return this.status(tenantId, locationId);
  }

  async disablePayAtTable(tenantId: string, locationId: string) {
    const { loc, cfg } = await this.requireConfig(tenantId, locationId);
    // Our side refuses every EPOS call from now on (checkEposAuth reads
    // `enabled`), which is the part that matters. Registering an empty
    // capability list tells Dojo to stop offering it on the machines.
    await this.clientFor(cfg)
      .registerRestIntegration({
        url: `${this.publicApiBase()}/v1/dojo/epos/${loc.id}`,
        username: cfg.payAtTable?.username ?? `orderhub-${loc.id}`,
        password: randomBytes(24).toString("base64url"),
        capabilities: [],
      })
      .catch((err: any) =>
        this.logger.warn(`Dojo Pay at Table deregistration failed at ${loc.id}: ${err?.message}`),
      );
    cfg.payAtTable = null;
    await this.saveConfig(loc.id, cfg);
    return this.status(tenantId, locationId);
  }

  /**
   * Authenticate a Pay at Table call from Dojo. Returns the location (and
   * its tenant) the credentials belong to, or null. Deliberately answers
   * "no" the same way for unknown location, disabled, and wrong password.
   */
  async checkEposAuth(locationId: string, authorization: string | undefined) {
    if (!authorization?.startsWith("Basic ")) return null;
    let user = "";
    let pass = "";
    try {
      const decoded = Buffer.from(authorization.slice(6).trim(), "base64").toString("utf8");
      const idx = decoded.indexOf(":");
      if (idx < 0) return null;
      user = decoded.slice(0, idx);
      pass = decoded.slice(idx + 1);
    } catch {
      return null;
    }
    const loc = await this.prisma.location.findFirst({
      where: { id: locationId, deletedAt: null },
      select: { id: true, name: true, country: true, settings: true, address: true, phone: true, brand: { select: { tenantId: true, name: true } } } as any,
    });
    if (!loc) return null;
    const cfg = this.configFrom((loc as any).settings);
    const pat = cfg?.payAtTable;
    if (!cfg || !pat?.enabled) return null;
    if (user !== pat.username) return null;
    if (!safeEqualHex(hashSecret(pass), pat.passwordHash)) return null;
    return { loc: loc as any, cfg, tenantId: (loc as any).brand.tenantId as string };
  }

  // ── Charging an order at the counter ──────────────────────────────────────

  private currencyFor(country: string | null | undefined): string {
    const cur = currencyForCountry(country).toUpperCase();
    if (cur !== "GBP" && cur !== "EUR") {
      throw new BadRequestException(`Dojo only takes GBP and EUR — this location trades in ${cur}.`);
    }
    return cur;
  }

  private async paidSoFarGbp(orderId: string): Promise<number> {
    const rows = await (this.prisma as any).payment.findMany({
      where: { orderId, status: "SUCCEEDED" },
      select: { amount: true },
    });
    return Math.round(rows.reduce((s: number, p: any) => s + Number(p.amount), 0) * 100) / 100;
  }

  /**
   * Push an order (or, with `amount`, one share of a split bill) to a Dojo
   * card machine. Same split semantics as TerminalService.chargeOrder: the
   * ceiling is what's still OWED, and a part only settles itself.
   */
  async chargeOrder(args: { tenantId: string; orderId: string; terminalId: string; amount?: number }) {
    const order = await this.prisma.order.findFirst({
      where: { id: args.orderId, tenantId: args.tenantId },
      select: { id: true, tenantId: true, locationId: true, displayId: true, total: true, paymentStatus: true },
    });
    if (!order) throw new NotFoundException("Order not found");
    if (order.paymentStatus === "PAID") throw new BadRequestException("Order is already paid");
    if (!order.locationId) throw new BadRequestException("Order has no location");

    const { loc, cfg } = await this.requireConfig(args.tenantId, order.locationId);
    const currency = this.currencyFor(loc.country);

    const orderTotal = Number(order.total ?? 0);
    const isSplit = args.amount !== undefined && args.amount !== null;
    let charge = orderTotal;
    if (isSplit) {
      const requested = Math.round(Number(args.amount) * 100) / 100;
      if (!Number.isFinite(requested) || requested <= 0) {
        throw new BadRequestException("Amount must be greater than zero");
      }
      const remaining = Math.round((orderTotal - (await this.paidSoFarGbp(order.id))) * 100) / 100;
      if (remaining <= 0) throw new BadRequestException("This bill is already fully paid");
      if (requested > remaining + 0.01) {
        throw new BadRequestException(`That's more than the ${remaining.toFixed(2)} still owed`);
      }
      charge = requested;
    }
    const amountMinor = Math.round(charge * 100);
    if (amountMinor <= 0) throw new BadRequestException("Order total must be > 0");

    const client = this.clientFor(cfg);

    // Dojo's go-live checklist: "POS should re-use Payment Intent if the
    // transaction is re-attempted" after a decline. A declined or cancelled
    // session leaves the intent open (still `Created`), so a retry for the
    // same amount points a NEW session at the SAME intent instead of minting
    // a fresh one per attempt.
    const reusable = await this.reusableIntent(order.id, charge, isSplit, client);
    const pi =
      reusable?.pi ??
      (await client.createPaymentIntent({
        amountMinor,
        currencyCode: currency,
        reference: order.displayId ? `Order ${order.displayId}` : `Order ${order.id.slice(-8)}`,
        description: loc.name,
        metadata: { orderhubOrderId: order.id, orderhubLocationId: order.locationId },
      }));

    let session;
    try {
      session = await client.createSaleSession(args.terminalId, pi.id);
    } catch (err: any) {
      // Nothing reached the customer — don't leave a fresh intent behind.
      // (A re-used one stays: it's the one the next retry will point at.)
      if (!reusable) await client.cancelPaymentIntent(pi.id).catch(() => undefined);
      throw new BadRequestException(this.sessionStartError(err));
    }

    const metadata = {
      source: "dojo_terminal",
      terminalId: args.terminalId,
      terminalSessionId: session.id,
      ...(isSplit ? { split: true } : {}),
      ...(cfg.environment === "sandbox" ? { sandbox: true } : {}),
    };
    if (reusable) {
      await (this.prisma as any).payment.update({
        where: { id: reusable.paymentId },
        data: { status: "PROCESSING", metadata },
      });
    } else {
      await (this.prisma as any).payment.create({
        data: {
          tenantId: order.tenantId,
          orderId: order.id,
          provider: "DOJO",
          providerChargeId: pi.id,
          amount: charge,
          currency: currency.toLowerCase(),
          status: "PROCESSING",
          method: "CARD",
          platformFee: 0,
          netAmount: charge,
          metadata,
        },
      });
    }

    this.logger.log(
      `Dojo charge started: order ${order.id} ${charge.toFixed(2)} ${currency}` +
        `${isSplit ? ` (split of ${orderTotal.toFixed(2)})` : ""} on ${args.terminalId} ` +
        `(${pi.id}${reusable ? ", re-used after a failed attempt" : ""}, ${session.id})`,
    );
    return {
      paymentIntentId: pi.id,
      terminalSessionId: session.id,
      status: session.status,
      amount: charge,
      sandbox: cfg.environment === "sandbox",
    };
  }

  /** A failed attempt's intent for this same charge that Dojo still has open. */
  private async reusableIntent(
    orderId: string,
    charge: number,
    isSplit: boolean,
    client: DojoApiClient,
  ): Promise<{ paymentId: string; pi: DojoPaymentIntent } | null> {
    const failed = await (this.prisma as any).payment.findMany({
      where: { orderId, provider: "DOJO", status: "FAILED" },
      orderBy: { createdAt: "desc" },
      take: 3,
    });
    for (const p of failed) {
      if (Math.round(Number(p.amount) * 100) !== Math.round(charge * 100)) continue;
      if (!!(p.metadata as any)?.split !== isSplit) continue;
      if ((p.metadata as any)?.source !== "dojo_terminal") continue;
      try {
        const pi = await client.getPaymentIntent(p.providerChargeId);
        if (pi.status === "Created") return { paymentId: p.id, pi };
      } catch {
        /* gone or unreachable — just make a new one */
      }
    }
    return null;
  }

  /** Plain-English reason a terminal session couldn't be started (checklist error handling). */
  private sessionStartError(err: any): string {
    if (err instanceof DojoApiError) {
      if (err.status === 409) return "That card machine is busy with another payment, or offline. Check it and try again.";
      if (err.status === 404) {
        return "That card machine can't be reached. Check it's switched on and connected to the internet.";
      }
      if (err.status === 401 || err.status === 403) {
        return "Dojo refused the request. Check this location's Dojo API key is correct (Card readers page).";
      }
    }
    return `Couldn't start the payment on the card machine: ${err?.message ?? "unknown error"}`;
  }

  private async loadDojoPayment(tenantId: string, paymentIntentId: string) {
    const payment = await (this.prisma as any).payment.findFirst({
      where: { providerChargeId: paymentIntentId, provider: "DOJO", tenantId },
      include: { order: { select: { id: true, locationId: true } } },
    });
    if (!payment) throw new NotFoundException("Payment not found");
    const { cfg } = await this.requireConfig(tenantId, payment.order.locationId);
    return { payment, cfg };
  }

  /** POS poll. Settles on success; reports failure, prompts and signature checks. */
  async chargeStatus(tenantId: string, paymentIntentId: string) {
    const { payment, cfg } = await this.loadDojoPayment(tenantId, paymentIntentId);
    const base = { paymentIntentId };
    if (payment.status === "SUCCEEDED") {
      return { ...base, status: "Captured", paid: true, failed: false, needsSignature: false, unconfirmed: false };
    }
    const client = this.clientFor(cfg);
    const sessionId = (payment.metadata as any)?.terminalSessionId as string | undefined;
    const session = sessionId ? await client.getTerminalSession(sessionId) : null;
    const sessionStatus = session?.status ?? null;
    // What the machine is showing right now — "Insert card", "Enter PIN" …
    // The checklist asks the POS to display these, not just a spinner.
    const events = session?.notificationEvents ?? [];
    const prompt = events.length ? events[events.length - 1]!.notificationType : null;

    // Captured — or an Expired session, whose outcome the machine never
    // reported back: the intent itself is the only source of truth for it.
    if (sessionStatus === "Captured" || sessionStatus === "Expired" || !session) {
      const settled = await this.verifyAndSettle(payment, client, { allowAuthorized: false });
      if (settled) {
        return { ...base, status: "Captured", paid: true, failed: false, needsSignature: false, unconfirmed: false };
      }
    }

    if (sessionStatus === "Expired") {
      // Checklist: "display dialogue advising the result cannot be confirmed;
      // offer manual record or retry". Nothing settles here — the operator
      // looks at the machine and either records it manually or retries.
      await this.markFailed(payment);
      return {
        ...base,
        status: sessionStatus,
        paid: false,
        failed: true,
        unconfirmed: true,
        needsSignature: false,
        message:
          "The card machine didn't confirm the result. Check the machine: if it shows APPROVED, " +
          "record the payment manually; otherwise try again.",
      };
    }

    if (sessionStatus && FAILED_SESSION.has(sessionStatus)) {
      await this.markFailed(payment);
      return {
        ...base,
        status: sessionStatus,
        paid: false,
        failed: true,
        unconfirmed: false,
        needsSignature: false,
        message:
          sessionStatus === "Declined"
            ? "Card declined. You can try again."
            : sessionStatus === "SignatureVerificationRejected"
              ? "Signature rejected — nothing was taken."
              : "Payment cancelled on the card machine.",
      };
    }
    return {
      ...base,
      status: sessionStatus ?? "Unknown",
      prompt,
      paid: false,
      failed: false,
      unconfirmed: false,
      needsSignature: sessionStatus === "SignatureVerificationRequired",
    };
  }

  private async markFailed(payment: any) {
    if (payment.status === "FAILED") return;
    await (this.prisma as any).payment.update({
      where: { id: payment.id },
      data: { status: "FAILED" },
    });
  }

  async cancelCharge(tenantId: string, paymentIntentId: string) {
    const { payment, cfg } = await this.loadDojoPayment(tenantId, paymentIntentId);
    const sessionId = (payment.metadata as any)?.terminalSessionId as string | undefined;
    if (!sessionId) throw new BadRequestException("This payment has no card machine session");
    try {
      await this.clientFor(cfg).cancelTerminalSession(sessionId);
    } catch (err: any) {
      // 422 = too late to cancel (the card is already being processed).
      throw new BadRequestException(
        err instanceof DojoApiError && err.status === 422
          ? "Too late to cancel — the card machine is already processing the card."
          : `Couldn't cancel: ${err?.message}`,
      );
    }
    return { ok: true };
  }

  async respondToSignature(tenantId: string, paymentIntentId: string, accepted: boolean) {
    const { payment, cfg } = await this.loadDojoPayment(tenantId, paymentIntentId);
    const sessionId = (payment.metadata as any)?.terminalSessionId as string | undefined;
    if (!sessionId) throw new BadRequestException("This payment has no card machine session");
    await this.clientFor(cfg).respondToSignature(sessionId, accepted === true);
    return { ok: true };
  }

  // ── Verification + settlement (the only way a Dojo payment becomes money) ──

  /**
   * Fetch the intent from Dojo with the shop's own key and settle the
   * Payment row only if Dojo says the money is there, for our amount.
   * Returns true when the row is (now) settled.
   */
  async verifyAndSettle(
    payment: any,
    client: DojoApiClient,
    opts: { allowAuthorized: boolean },
  ): Promise<boolean> {
    if (payment.status === "SUCCEEDED") return true;
    let pi: DojoPaymentIntent;
    try {
      pi = await client.getPaymentIntent(payment.providerChargeId);
    } catch (err: any) {
      this.logger.warn(`Dojo PI fetch failed for ${payment.providerChargeId}: ${err?.message}`);
      return false;
    }
    if (!this.intentCovers(pi, Math.round(Number(payment.amount) * 100), opts.allowAuthorized)) {
      return false;
    }
    // Gratuity added on the card machine rides on the intent, not our row.
    const tipMinor = pi.tipsAmount?.value ?? 0;
    if (tipMinor > 0 && Math.round(Number(payment.tipAmount ?? 0) * 100) !== tipMinor) {
      await (this.prisma as any).payment.update({
        where: { id: payment.id },
        data: { tipAmount: tipMinor / 100 },
      });
    }
    await this.payments.settleCardPresentPayment(payment, pi.id);
    this.logger.log(`Dojo payment settled: order ${payment.orderId} (${pi.id})`);
    return true;
  }

  // ── Refunds (checklist: at least one refund method is mandatory) ─────────

  /**
   * Refund a Dojo card payment through its payment intent — full when
   * `amount` is omitted, partial otherwise. The Payment row's refunded total
   * lives in metadata.refundedMinor so repeated partial refunds can never
   * add up to more than was taken.
   */
  async refundPayment(args: {
    tenantId: string;
    paymentIntentId: string;
    amount?: number;
    reason?: string;
    userId?: string;
  }) {
    const { payment, cfg } = await this.loadDojoPayment(args.tenantId, args.paymentIntentId);
    return this.refundRow(payment, cfg, args.amount, args.reason, args.userId);
  }

  /** Cancelled/rejected order: refund every Dojo payment on it in full. */
  async refundOrder(orderId: string, reason = "Order cancelled"): Promise<void> {
    const rows = await (this.prisma as any).payment.findMany({
      where: { orderId, provider: "DOJO", status: "SUCCEEDED" },
      include: { order: { select: { locationId: true } } },
    });
    for (const payment of rows) {
      const loc = await this.prisma.location.findUnique({
        where: { id: payment.order.locationId },
        select: { settings: true },
      });
      const cfg = this.configFrom(loc?.settings);
      if (!cfg) {
        this.logger.error(`Dojo refund skipped for order ${orderId}: Dojo no longer connected at the location`);
        continue;
      }
      await this.refundRow(payment, cfg, undefined, reason).catch((err: any) =>
        this.logger.error(`Dojo refund failed for order ${orderId} (${payment.providerChargeId}): ${err?.message}`),
      );
    }
  }

  private async refundRow(payment: any, cfg: DojoLocationConfig, amount?: number, reason?: string, userId?: string) {
    if (payment.status !== "SUCCEEDED" && payment.status !== "REFUNDED") {
      throw new BadRequestException("Only a completed card payment can be refunded");
    }
    const takenMinor = Math.round(Number(payment.amount) * 100);
    const refundedMinor = Number((payment.metadata as any)?.refundedMinor ?? 0);
    const leftMinor = takenMinor - refundedMinor;
    if (leftMinor <= 0) throw new BadRequestException("This payment has already been refunded in full");
    const wantMinor = amount === undefined || amount === null ? leftMinor : Math.round(Number(amount) * 100);
    if (!Number.isFinite(wantMinor) || wantMinor <= 0) throw new BadRequestException("Refund amount must be greater than zero");
    if (wantMinor > leftMinor) {
      throw new BadRequestException(`Only ${(leftMinor / 100).toFixed(2)} is left to refund on this payment`);
    }

    const client = this.clientFor(cfg);
    // Same key for the same (payment, already-refunded, amount) state, so a
    // retried request can't refund twice; a later refund gets a new key.
    const res = await client.refundPaymentIntent({
      paymentIntentId: payment.providerChargeId,
      amountMinor: wantMinor,
      reason,
      idempotencyKey: `orderhub-refund-${payment.id}-${refundedMinor}-${wantMinor}`,
    });

    // Checklist: after refunding, GET the intent and show its status —
    // `Refunded` for a full refund, still `Captured` for a partial one.
    const pi = await client.getPaymentIntent(payment.providerChargeId).catch(() => null);
    const nowRefunded = refundedMinor + wantMinor;
    const full = nowRefunded >= takenMinor;

    await this.prisma.$transaction([
      (this.prisma as any).payment.update({
        where: { id: payment.id },
        data: {
          status: full ? "REFUNDED" : "SUCCEEDED",
          metadata: { ...(payment.metadata as any), refundedMinor: nowRefunded },
        },
      }),
      (this.prisma as any).refund.create({
        data: {
          tenantId: payment.tenantId,
          paymentId: payment.id,
          amount: wantMinor / 100,
          reason: reason ?? null,
          status: "SUCCEEDED",
          isPartial: !full,
          processedBy: userId ?? null,
          note: res?.refundId ? `Dojo refund ${res.refundId}` : null,
        },
      }),
    ]);

    // The ORDER is only "refunded" once everything taken on it has gone back.
    const all = await (this.prisma as any).payment.findMany({
      where: { orderId: payment.orderId, status: { in: ["SUCCEEDED", "REFUNDED"] } },
      select: { amount: true, status: true, metadata: true },
    });
    const orderTaken = all.reduce((s: number, p: any) => s + Math.round(Number(p.amount) * 100), 0);
    const orderRefunded = all.reduce(
      (s: number, p: any) =>
        s + (p.status === "REFUNDED" ? Math.round(Number(p.amount) * 100) : Number((p.metadata as any)?.refundedMinor ?? 0)),
      0,
    );
    await this.prisma.order.update({
      where: { id: payment.orderId },
      data: { paymentStatus: (orderRefunded >= orderTaken ? "REFUNDED" : "PARTIALLY_REFUNDED") as any },
    });

    this.logger.log(
      `Dojo refund ${res?.refundId ?? "?"}: ${(wantMinor / 100).toFixed(2)} on ${payment.providerChargeId} ` +
        `(${full ? "full" : "partial"}; intent now ${pi?.status ?? "unknown"})`,
    );
    return {
      refundId: res?.refundId ?? null,
      amount: wantMinor / 100,
      full,
      paymentIntentStatus: pi?.status ?? null,
      leftToRefund: (takenMinor - nowRefunded) / 100,
    };
  }

  /** Is this intent real money for (at least) `amountMinor`, excluding tips? */
  intentCovers(pi: DojoPaymentIntent, amountMinor: number, allowAuthorized: boolean): boolean {
    const okStatus = pi.status === "Captured" || (allowAuthorized && pi.status === "Authorized");
    if (!okStatus) return false;
    const base = pi.amount?.value;
    const total = pi.totalAmount?.value;
    const tips = pi.tipsAmount?.value ?? 0;
    return base === amountMinor || (typeof total === "number" && total - tips === amountMinor);
  }

  /**
   * Webhook nudge. The payload shape isn't in Dojo's published spec, so we
   * treat it as untrusted: find a pi_… id anywhere in it and re-verify.
   */
  async handleWebhook(locationId: string, body: unknown) {
    const piId = findPaymentIntentId(body);
    if (!piId) return;
    const payment = await (this.prisma as any).payment.findFirst({
      where: { providerChargeId: piId, provider: "DOJO" },
      include: { order: { select: { locationId: true } } },
    });
    if (!payment || payment.order?.locationId !== locationId) return;
    const loc = await this.prisma.location.findUnique({
      where: { id: locationId },
      select: { settings: true },
    });
    const cfg = this.configFrom(loc?.settings);
    if (!cfg) return;
    await this.verifyAndSettle(payment, this.clientFor(cfg), { allowAuthorized: false });
  }
}

/** First string that looks like a Dojo payment intent id, anywhere in a payload. */
export function findPaymentIntentId(body: unknown, depth = 0): string | null {
  if (depth > 6 || body == null) return null;
  if (typeof body === "string") return /^pi_[A-Za-z0-9_-]+$/.test(body) ? body : null;
  if (Array.isArray(body)) {
    for (const v of body) {
      const hit = findPaymentIntentId(v, depth + 1);
      if (hit) return hit;
    }
    return null;
  }
  if (typeof body === "object") {
    for (const v of Object.values(body as Record<string, unknown>)) {
      const hit = findPaymentIntentId(v, depth + 1);
      if (hit) return hit;
    }
  }
  return null;
}
