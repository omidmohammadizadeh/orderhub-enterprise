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

/** The API's own public origin — the same one the HubRise callback defaults to. */
export const DEFAULT_PUBLIC_API_ORIGIN = "https://orderhub-api-0re6.onrender.com";

/**
 * A configured base URL, only if a partner could actually call it: https,
 * with a dotted public hostname. "orderhub-api-0re6" and "http://localhost:4000"
 * both fail — neither is reachable from Dojo.
 */
export function usableHttpsOrigin(raw: string | null | undefined): string | null {
  const value = String(raw ?? "").trim().replace(/\/+$/, "");
  if (!value) return null;
  const withScheme = /^https?:\/\//i.test(value) ? value : `https://${value}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    return null;
  }
  if (url.protocol !== "https:") return null;
  if (!url.hostname.includes(".")) return null;
  if (/^(localhost|127\.|0\.0\.0\.0)/i.test(url.hostname)) return null;
  return `${url.origin}${url.pathname === "/" ? "" : url.pathname.replace(/\/+$/, "")}`;
}

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

  /**
   * Where Dojo reaches us. It must be a PUBLICLY RESOLVABLE https origin:
   * Dojo validates the webhook URL when subscribing ("The Url field is not a
   * valid fully-qualified https URL"), and Pay at Table registers the same
   * base as the EPOS endpoint — a bad value there fails silently at the
   * worst moment, when a waiter is standing at a table.
   *
   * Production's API_PUBLIC_URL was set to the bare Render SERVICE NAME
   * ("orderhub-api-0re6"), so anything that isn't a fully-qualified https
   * origin is discarded in favour of the known-good default rather than
   * handed to a partner.
   */
  private publicApiBase(): string {
    const configured =
      this.config.get<string>("API_PUBLIC_URL") ?? this.config.get<string>("PUBLIC_API_URL") ?? "";
    return (usableHttpsOrigin(configured) ?? DEFAULT_PUBLIC_API_ORIGIN) + "/api";
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
      this.logger.warn(
        `Dojo webhook subscribe failed for location ${loc.id} ` +
          `(url ${this.publicApiBase()}/v1/payments/dojo/webhook/${loc.id}): ${err?.message}`,
      );
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
    // `enabled`), and that is the ONLY thing actually switching it off.
    // The empty-capability PUT below does NOT deregister: Dojo answers 200
    // and leaves the capabilities exactly as they were (verified against
    // api.dojo.tech, 2026-09-23). It is kept because rotating the password
    // still invalidates the credentials Dojo holds. Dojo publishes no delete
    // for a REST integration — ask them for one.
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
  /**
   * The same context checkEposAuth builds, but for an ADMIN of this tenant
   * rather than for Dojo.
   *
   * Pay at Table can only be driven from a terminal running Dojo's table app,
   * and a virtual card machine doesn't have one — it simulates payment
   * outcomes, not the waiter's menu. So without hardware there is no way to
   * see what we would answer. This lets the dashboard ask our own handlers
   * directly and show the operator the actual JSON.
   *
   * It deliberately proves LESS than a real call: no HTTP, no Basic auth, no
   * terminal. What it does prove is the part we own — that the areas, tables,
   * open tabs and bill we would hand Dojo are correct.
   */
  async eposPreviewContext(tenantId: string, locationId: string) {
    const { loc, cfg } = await this.requireConfig(tenantId, locationId);
    return {
      ctx: { loc: loc as any, cfg, tenantId },
      payAtTableEnabled: !!cfg.payAtTable?.enabled,
    };
  }

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
    if (!payment) {
      // "Payment not found" on its own can't be debugged from a log: say WHICH
      // intent we looked for, and whether the row exists under another tenant.
      const elsewhere = await (this.prisma as any).payment.count({
        where: { providerChargeId: paymentIntentId, provider: "DOJO" },
      });
      this.logger.warn(
        `Dojo payment lookup missed: intent "${paymentIntentId}" tenant ${tenantId}` +
          ` — ${elsewhere} DOJO row(s) exist with that intent id`,
      );
      throw new NotFoundException("Payment not found");
    }
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
      // A dead session is not the same as "no money". Dojo's sandbox CAPTURED a
      // signature-rejected payment (VCMORHSSIS0, 2026-09-23) and only told us via
      // a webhook 90s later — so the till said "nothing was taken" about an order
      // that was, in fact, paid. Ask the intent before we say that to anyone.
      if (await this.verifyAndSettle(payment, client, { allowAuthorized: false })) {
        return { ...base, status: "Captured", paid: true, failed: false, needsSignature: false, unconfirmed: false };
      }
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
    // The settle can decline — a refunded payment must not be banked again —
    // and this used to log "settled" regardless, one line after the refusal
    // (2026-09-23). The intent is still real money for the caller either way;
    // only the log was wrong.
    const banked = await this.payments.settleCardPresentPayment(payment, pi.id);
    this.logger.log(
      banked
        ? `Dojo payment settled: order ${payment.orderId} (${pi.id})`
        : `Dojo payment for order ${payment.orderId} needed no settling (${pi.id})`,
    );
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

  /**
   * Cancelled/rejected order. A card-present refund needs the customer's card
   * at the machine, so there is nothing to do unattended here and pretending
   * otherwise would be worse than useless: the order would look refunded while
   * the customer still had no money back. Instead we mark what is owed, and
   * the order drawer offers "Refund on card machine" for when they're there.
   */
  async refundOrder(orderId: string, reason = "Order cancelled"): Promise<void> {
    const rows = await (this.prisma as any).payment.findMany({
      where: { orderId, provider: "DOJO", status: { in: ["SUCCEEDED", "REFUNDED"] } },
    });
    for (const payment of rows) {
      const owedMinor = this.refundOwed(payment);
      if (owedMinor <= 0) continue;
      await (this.prisma as any).payment.update({
        where: { id: payment.id },
        data: {
          metadata: { ...(payment.metadata as any), refundOwedMinor: owedMinor, refundOwedReason: reason },
        },
      });
      this.logger.warn(
        `Dojo: order ${orderId} cancelled with ${(owedMinor / 100).toFixed(2)} still on the customer's card — ` +
          `a card-present refund is needed on the machine`,
      );
    }
  }

  // ── Refund on the card machine (the only way back for a card-present sale) ─
  //
  // Dojo refuses BOTH /refunds and /reversal on a terminal capture (400, both
  // of them, sandbox 2026-09-23). Its rule: money taken with a card at the
  // machine goes back with the card at the machine — a "matched refund"
  // terminal session running a negative transaction. So this mirrors taking a
  // payment: start a session, poll it, and only write the books when Dojo says
  // the money moved. The customer has to be standing there with the card.

  /** Put a refund on the machine. Returns the session to poll. */
  async startTerminalRefund(args: {
    tenantId: string;
    paymentIntentId: string;
    terminalId?: string;
    amount?: number;
    reason?: string;
    userId?: string;
  }) {
    const { payment, cfg } = await this.loadDojoPayment(args.tenantId, args.paymentIntentId);
    const { leftMinor, wantMinor } = this.refundAmounts(payment, args.amount);
    const terminalId = args.terminalId ?? cfg.terminals[0]?.id;
    if (!terminalId) {
      throw new BadRequestException("No card machine is set up at this location (Card readers page).");
    }
    const client = this.clientFor(cfg);
    const session = await client.createRefundSession({
      terminalId,
      paymentIntentId: payment.providerChargeId,
      // Leave the amount out for the whole remainder — that is Dojo's
      // documented minimal matched refund; send it only for a part refund.
      ...(wantMinor < leftMinor ? { amountMinor: wantMinor, currencyCode: payment.currency } : {}),
    });

    await (this.prisma as any).payment.update({
      where: { id: payment.id },
      data: {
        metadata: {
          ...(payment.metadata as any),
          refundSession: {
            id: session.id,
            terminalId,
            amountMinor: wantMinor,
            reason: args.reason ?? null,
            userId: args.userId ?? null,
            startedAt: new Date().toISOString(),
          },
        },
      },
    });

    this.logger.log(
      `Dojo matched refund started: ${(wantMinor / 100).toFixed(2)} on ${payment.providerChargeId} ` +
        `via ${terminalId} (${session.id})`,
    );
    return { terminalSessionId: session.id, amount: wantMinor / 100, status: session.status };
  }

  /** Poll the refund session. Writes the books once, when Dojo confirms it. */
  async terminalRefundStatus(tenantId: string, paymentIntentId: string) {
    const { payment, cfg } = await this.loadDojoPayment(tenantId, paymentIntentId);
    const pending = (payment.metadata as any)?.refundSession;
    if (!pending?.id) return { active: false as const };

    const session = await this.clientFor(cfg).getTerminalSession(pending.id);
    const status = session?.status ?? null;
    const events = session?.notificationEvents ?? [];
    const base = {
      active: true as const,
      terminalSessionId: pending.id as string,
      amount: Number(pending.amountMinor ?? 0) / 100,
      status,
      prompt: events.length ? events[events.length - 1]!.notificationType : null,
    };

    if (status === "Captured" || status === "SignatureVerificationAccepted") {
      const done = await this.recordRefund(payment, Number(pending.amountMinor), {
        note: `Dojo terminal refund ${pending.id}`,
        reason: pending.reason ?? undefined,
        userId: pending.userId ?? undefined,
      });
      this.logger.log(`Dojo matched refund done: ${done.amount.toFixed(2)} on ${payment.providerChargeId}`);
      return { ...base, done: true, failed: false, ...done };
    }

    if (status && FAILED_SESSION.has(status)) {
      // Nothing moved — drop the pending session so staff can try again.
      await (this.prisma as any).payment.update({
        where: { id: payment.id },
        data: { metadata: { ...(payment.metadata as any), refundSession: null } },
      });
      return {
        ...base,
        done: false,
        failed: true,
        message:
          status === "Declined"
            ? "The card machine declined the refund. Try again, or use a different card."
            : status === "Expired"
              ? "The card machine timed out before the card was presented."
              : "The refund was cancelled on the card machine.",
      };
    }
    return { ...base, done: false, failed: false };
  }

  /** How much is still owed back on this payment. */
  private refundOwed(payment: any): number {
    const takenMinor = Math.round(Number(payment.amount) * 100);
    const refundedMinor = Number((payment.metadata as any)?.refundedMinor ?? 0);
    return Math.max(0, takenMinor - refundedMinor);
  }

  /** How much of this payment may go back, and how much is being asked for. */
  private refundAmounts(payment: any, amount?: number) {
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
    return { takenMinor, refundedMinor, leftMinor, wantMinor };
  }

  private async refundRow(payment: any, cfg: DojoLocationConfig, amount?: number, reason?: string, userId?: string) {
    const { takenMinor, refundedMinor, leftMinor, wantMinor } = this.refundAmounts(payment, amount);

    const client = this.clientFor(cfg);
    // Same key for the same (payment, already-refunded, amount) state, so a
    // retried request can't refund twice; a later refund gets a new key.
    const idempotencyKey = `orderhub-refund-${payment.id}-${refundedMinor}-${wantMinor}`;
    // Dojo will not REFUND money it has not settled yet: a same-day capture
    // answers "Your refund request was not successful. Status: Failed."
    // (sandbox, 2026-09-23). Until settlement the way back is a REVERSAL —
    // whole amount only, captureMode:Auto (which is all we create), within 7
    // days. So an untouched payment being given back in full goes out as a
    // reversal, and only falls back to a refund when Dojo refuses it (window
    // expired, or already settled — in which case the refund is the right
    // call anyway). A part-refund has no reversal to fall back on.
    const wholePayment = refundedMinor === 0 && wantMinor === takenMinor;
    let res: { refundId?: string | null } | null = null;
    let via: "reversal" | "refund" = "refund";
    if (wholePayment) {
      try {
        await client.reversePaymentIntent(payment.providerChargeId, idempotencyKey);
        via = "reversal";
      } catch (err: any) {
        if (!(err instanceof DojoApiError)) throw err;
        this.logger.warn(
          `Dojo reversal refused for ${payment.providerChargeId} (${err.message}) — trying a refund instead`,
        );
      }
    }
    if (via === "refund") {
      try {
        res = await client.refundPaymentIntent({
          paymentIntentId: payment.providerChargeId,
          amountMinor: wantMinor,
          reason,
          idempotencyKey,
        });
      } catch (err: any) {
        // Tell the operator what they can actually do about it.
        if (err instanceof DojoApiError && !wholePayment) {
          throw new BadRequestException(
            `${err.message} — Dojo can only refund PART of a payment once it has settled (usually the next ` +
              `working day). To give the whole amount back today, use the full refund button.`,
          );
        }
        throw err;
      }
    }

    // Checklist: after refunding, GET the intent and show its status —
    // `Refunded` for a full refund, still `Captured` for a partial one.
    const pi = await client.getPaymentIntent(payment.providerChargeId).catch(() => null);
    const done = await this.recordRefund(payment, wantMinor, {
      note: res?.refundId ? `Dojo refund ${res.refundId}` : via === "reversal" ? "Dojo reversal" : null,
      reason,
      userId,
    });
    this.logger.log(
      `Dojo ${via} ${res?.refundId ?? ""}: ${(wantMinor / 100).toFixed(2)} on ${payment.providerChargeId} ` +
        `(${done.full ? "full" : "partial"}; intent now ${pi?.status ?? "unknown"})`,
    );
    return { refundId: res?.refundId ?? null, ...done, paymentIntentStatus: pi?.status ?? null };
  }

  /**
   * The books, once money has actually gone back — whichever way it went
   * (payment-intent refund, reversal, or a refund taken on the card machine).
   * Idempotent per `note`: a duplicated poll can't write the refund twice.
   */
  private async recordRefund(
    payment: any,
    wantMinor: number,
    opts: { note?: string | null; reason?: string; userId?: string },
  ): Promise<{ amount: number; full: boolean; leftToRefund: number }> {
    const takenMinor = Math.round(Number(payment.amount) * 100);
    const refundedMinor = Number((payment.metadata as any)?.refundedMinor ?? 0);
    if (opts.note) {
      const already = await (this.prisma as any).refund.findFirst({
        where: { paymentId: payment.id, note: opts.note },
        select: { id: true },
      });
      if (already) {
        return {
          amount: wantMinor / 100,
          full: refundedMinor >= takenMinor,
          leftToRefund: Math.max(0, takenMinor - refundedMinor) / 100,
        };
      }
    }
    const nowRefunded = refundedMinor + wantMinor;
    const full = nowRefunded >= takenMinor;
    // A cancelled order carries what it still owes the customer; paying part
    // of it back must shrink that figure, not leave the order shouting.
    const owedMinor = Number((payment.metadata as any)?.refundOwedMinor ?? 0);
    const stillOwed = owedMinor > 0 ? Math.max(0, owedMinor - wantMinor) : 0;

    await this.prisma.$transaction([
      (this.prisma as any).payment.update({
        where: { id: payment.id },
        data: {
          status: full ? "REFUNDED" : "SUCCEEDED",
          metadata: {
            ...(payment.metadata as any),
            refundedMinor: nowRefunded,
            refundSession: null,
            refundOwedMinor: stillOwed || null,
          },
        },
      }),
      (this.prisma as any).refund.create({
        data: {
          tenantId: payment.tenantId,
          paymentId: payment.id,
          amount: wantMinor / 100,
          reason: opts.reason ?? null,
          status: "SUCCEEDED",
          isPartial: !full,
          processedBy: opts.userId ?? null,
          note: opts.note ?? null,
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

    return { amount: wantMinor / 100, full, leftToRefund: (takenMinor - nowRefunded) / 100 };
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
