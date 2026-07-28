import {
  Injectable,
  Logger,
  BadRequestException,
  NotFoundException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { PrismaService } from "../../infrastructure/database/prisma.service";
import { PaymentsService } from "./payments.service";

// Lazy Stripe — same pattern as PaymentsService (mock paths when unset).
let Stripe: any;
try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  Stripe = require("stripe").default ?? require("stripe");
} catch {
  /* mock mode */
}

// Exported: the controller's method return types reference this, and
// declaration emit (TS4053) fails if it can't be named from outside.
export interface StoredReader {
  id: string; // tmr_…
  label: string;
  deviceType: string | null;
  simulated: boolean;
  addedAt: string;
}
interface TerminalConfig {
  stripeLocationId: string | null; // tml_… (LIVE mode)
  // Stripe Terminal locations are per-mode; simulated readers register
  // against a separate TEST-mode location.
  stripeTestLocationId?: string | null;
  readers: StoredReader[];
}

// Stripe Terminal S700 / WisePOS E — SERVER-DRIVEN readers.
//
// The reader connects to Stripe over the shop's Wi-Fi and WE push the charge
// to it from the server (no native SDK, no per-tablet pairing) — so iPad,
// Android, and desktop dashboard all drive the same counter reader.
//
// Flow per charge (destination charge, so the money lands in the location's
// connected account with our application fee, exactly like online orders):
//   1. create a card_present PaymentIntent (automatic capture)
//   2. readers.processPaymentIntent(reader, { payment_intent }) → reader
//      prompts tap/insert/PIN
//   3. success → webhook (metadata.source="terminal") OR the poll endpoint
//      settles it → order PAID.
//
// Test WITHOUT hardware: register a `simulated-wpe` reader, then
// simulatePresent() plays the card tap in test mode → the PI succeeds.
@Injectable()
export class TerminalService {
  private readonly logger = new Logger(TerminalService.name);
  private readonly stripe: any;
  // "Test drive" client: production runs a LIVE main key (which Stripe
  // rightly refuses to pair with simulated readers), so simulated readers +
  // their charges run on a separate TEST-mode client from
  // STRIPE_TEST_SECRET_KEY. When the main key is already a test key, the
  // same client serves both roles.
  private readonly stripeTest: any;

  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
    private readonly payments: PaymentsService,
  ) {
    const key = this.config.get<string>("STRIPE_SECRET_KEY");
    this.stripe = key && Stripe ? new Stripe(key, { apiVersion: "2024-06-20" }) : null;
    const mainIsTest =
      (key ?? "").startsWith("sk_test") || (key ?? "").startsWith("rk_test");
    const testKey = this.config.get<string>("STRIPE_TEST_SECRET_KEY");
    this.stripeTest = mainIsTest
      ? this.stripe
      : testKey && Stripe
        ? new Stripe(testKey, { apiVersion: "2024-06-20" })
        : null;
  }

  private assertStripe() {
    if (!this.stripe) {
      throw new BadRequestException(
        "Stripe isn't configured on the server (missing STRIPE_SECRET_KEY).",
      );
    }
  }

  /** Pick the Stripe client for a reader: simulated readers live in test mode. */
  private client(simulated: boolean): any {
    if (!simulated) {
      this.assertStripe();
      return this.stripe;
    }
    if (!this.stripeTest) {
      throw new BadRequestException(
        "Simulated readers need Stripe test mode — set STRIPE_TEST_SECRET_KEY in the server env (the live key stays for real payments).",
      );
    }
    return this.stripeTest;
  }

  /** True when the simulated-reader test drive is available. */
  get isTestMode(): boolean {
    return !!this.stripeTest;
  }

  // ── Config persistence (Location.settings.terminal — no schema change) ────

  private async loadLocation(tenantId: string, locationId: string) {
    const loc = await this.prisma.location.findFirst({
      where: { id: locationId, brand: { tenantId }, deletedAt: null },
      select: { id: true, name: true, address: true, settings: true },
    });
    if (!loc) throw new NotFoundException("Location not found");
    return loc;
  }

  private configFrom(loc: { settings: unknown }): TerminalConfig {
    const s = (loc.settings ?? {}) as Record<string, any>;
    const t = (s.terminal ?? {}) as Partial<TerminalConfig>;
    return {
      stripeLocationId: t.stripeLocationId ?? null,
      stripeTestLocationId: t.stripeTestLocationId ?? null,
      readers: Array.isArray(t.readers) ? (t.readers as StoredReader[]) : [],
    };
  }

  private async saveConfig(
    locationId: string,
    currentSettings: unknown,
    cfg: TerminalConfig,
  ) {
    const settings = { ...((currentSettings ?? {}) as Record<string, any>), terminal: cfg };
    await this.prisma.location.update({
      where: { id: locationId },
      data: { settings: settings as any },
    });
  }

  // ── Stripe Terminal Location (get-or-create) ──────────────────────────────

  // Stripe requires an ISO 3166-1 alpha-2 country (uppercase). Shops often
  // store "UK" (not a valid ISO code — GB is), "United Kingdom", or lowercase
  // "gb", any of which makes terminal.locations.create 400. Normalise, and
  // default to GB (this is a UK product).
  private normCountry(raw: unknown): string {
    const v = String(raw ?? "").trim();
    if (!v) return "GB";
    const map: Record<string, string> = {
      "united kingdom": "GB",
      uk: "GB",
      "great britain": "GB",
      england: "GB",
      scotland: "GB",
      wales: "GB",
      "northern ireland": "GB",
    };
    const hit = map[v.toLowerCase()];
    if (hit) return hit;
    if (v.length === 2) return v.toUpperCase();
    return "GB";
  }

  private async ensureStripeLocation(
    loc: { id: string; name: string; address: unknown; settings: unknown },
    cfg: TerminalConfig,
    opts: { test: boolean },
  ): Promise<string> {
    const existing = opts.test ? cfg.stripeTestLocationId : cfg.stripeLocationId;
    if (existing) return existing;
    const stripe = this.client(opts.test);
    const a = (loc.address ?? {}) as Record<string, any>;
    let created: any;
    try {
      created = await stripe.terminal.locations.create({
        display_name: loc.name || "Order Hub location",
        address: {
          line1: a.line1 || a.addressLine1 || "1 High Street",
          city: a.city || "London",
          postal_code: a.postcode || a.post_code || a.postal_code || "SW1A 1AA",
          country: this.normCountry(a.country),
        },
        metadata: { orderhubLocationId: loc.id },
      });
    } catch (err: any) {
      // Surface Stripe's real reason to the POS instead of a bare 400.
      throw new BadRequestException(
        `Couldn't set up the card reader for this location: ${err?.message ?? "Stripe rejected the location details"}`,
      );
    }
    if (opts.test) cfg.stripeTestLocationId = created.id;
    else cfg.stripeLocationId = created.id;
    await this.saveConfig(loc.id, loc.settings, cfg);
    this.logger.log(
      `Stripe Terminal ${opts.test ? "TEST " : ""}location ${created.id} created for ${loc.id}`,
    );
    return created.id;
  }

  // ── Reader registration ───────────────────────────────────────────────────

  async registerReader(args: {
    tenantId: string;
    locationId: string;
    registrationCode: string;
    label?: string;
  }): Promise<StoredReader> {
    // Simulated registration codes live in Stripe TEST mode; real S700
    // codes register against the live account.
    const simulated = args.registrationCode.includes("simulated");
    const stripe = this.client(simulated);
    const loc = await this.loadLocation(args.tenantId, args.locationId);
    const cfg = this.configFrom(loc);
    const stripeLocationId = await this.ensureStripeLocation(loc, cfg, {
      test: simulated,
    });

    const reader = await stripe.terminal.readers.create({
      registration_code: args.registrationCode.trim(),
      location: stripeLocationId,
      label: args.label?.trim() || "Counter reader",
    });

    const stored: StoredReader = {
      id: reader.id,
      label: reader.label ?? args.label ?? "Counter reader",
      deviceType: reader.device_type ?? null,
      simulated,
      addedAt: new Date().toISOString(),
    };
    cfg.readers = [...cfg.readers.filter((r) => r.id !== stored.id), stored];
    await this.saveConfig(loc.id, loc.settings, cfg);
    this.logger.log(
      `Reader ${reader.id}${simulated ? " (simulated/test)" : ""} registered at location ${loc.id}`,
    );
    return stored;
  }

  /** Convenience: register Stripe's built-in simulated reader (test drive). */
  async registerSimulatedReader(tenantId: string, locationId: string) {
    return this.registerReader({
      tenantId,
      locationId,
      registrationCode: "simulated-wpe",
      label: "Simulated reader",
    });
  }

  async listReaders(tenantId: string, locationId: string) {
    const loc = await this.loadLocation(tenantId, locationId);
    const cfg = this.configFrom(loc);
    // Best-effort live status; fall back to stored data if Stripe is down.
    const enriched = await Promise.all(
      cfg.readers.map(async (r) => {
        const stripe = r.simulated ? this.stripeTest : this.stripe;
        if (!stripe) return { ...r, status: "unknown" };
        try {
          const live = await stripe.terminal.readers.retrieve(r.id);
          return { ...r, status: live.status, deviceType: live.device_type ?? r.deviceType };
        } catch {
          return { ...r, status: "offline" };
        }
      }),
    );
    return { readers: enriched, stripeLocationId: cfg.stripeLocationId };
  }

  async removeReader(tenantId: string, locationId: string, readerId: string) {
    const loc = await this.loadLocation(tenantId, locationId);
    const cfg = this.configFrom(loc);
    const removed = cfg.readers.find((r) => r.id === readerId);
    cfg.readers = cfg.readers.filter((r) => r.id !== readerId);
    await this.saveConfig(loc.id, loc.settings, cfg);
    const stripe = removed?.simulated ? this.stripeTest : this.stripe;
    if (stripe) {
      await stripe.terminal.readers.del(readerId).catch(() => {
        /* already gone / not deletable */
      });
    }
    return { ok: true };
  }

  // ── SDK-driven (mobile) readers: BBPOS WisePad 3, Tap to Pay ──────────────
  //
  // Unlike the S700 (server-driven), a Bluetooth mobile reader or a phone's
  // Tap to Pay is driven by the Stripe Terminal SDK running ON the device.
  // The device needs a short-lived connection token to authenticate the SDK,
  // and a card_present PaymentIntent to collect against. Two endpoints:
  //   1. createConnectionToken → the SDK's tokenProvider calls this.
  //   2. createMobileCharge → server makes the card_present PI (Connect
  //      destination charge, same as the S700) and returns its client secret;
  //      the SDK collects + confirms on the reader, then the POS polls
  //      status() (below) to settle the order PAID.
  //
  // Test vs live follows the SERVER's Stripe key (test key on staging → the
  // SDK's simulated reader works; live key in prod → a real WisePad 3). The
  // client never chooses the mode, so a client can't force a free "paid".

  /** Short-lived Stripe Terminal connection token for the on-device SDK. When a
   *  location is supplied, also ENSURE its Stripe Terminal location exists and
   *  return its id — a Bluetooth reader (WisePad 3) requires that id to connect,
   *  and the POS fetches it here before pairing. */
  async createConnectionToken(tenantId: string, locationId?: string, simulated = false) {
    this.assertStripe();
    // Simulated (no-hardware) testing runs on the TEST client — client(true)
    // throws unless STRIPE_TEST_SECRET_KEY is set, so it can't be forced in
    // production, and it never touches the live account.
    const stripe = this.client(simulated);
    let stripeLocationId: string | null = null;
    if (locationId) {
      const loc = await this.loadLocation(tenantId, locationId);
      const cfg = this.configFrom(loc);
      stripeLocationId = await this.ensureStripeLocation(loc, cfg, { test: simulated });
    }
    const token = await stripe.terminal.connectionTokens.create();
    return { secret: token.secret, stripeLocationId, simulated };
  }

  /** Create a card_present PaymentIntent for an order and return its client
   *  secret for the on-device SDK to collect + confirm. Mirrors chargeOrder's
   *  Connect routing but does NOT push to a networked reader. */
  async createMobileCharge(args: { tenantId: string; orderId: string; simulated?: boolean }) {
    this.assertStripe();
    const simulated = args.simulated === true;
    // Simulated charges run on the TEST client (gated on STRIPE_TEST_SECRET_KEY)
    // and never move real money — for verifying the flow without hardware.
    const stripe = this.client(simulated);
    const order = await this.prisma.order.findFirst({
      where: { id: args.orderId, tenantId: args.tenantId },
      select: {
        id: true,
        tenantId: true,
        locationId: true,
        brandId: true,
        total: true,
        paymentStatus: true,
      },
    });
    if (!order) throw new NotFoundException("Order not found");
    if (order.paymentStatus === "PAID") {
      throw new BadRequestException("Order is already paid");
    }
    if (!order.locationId) throw new BadRequestException("Order has no location");

    const basketGbp = Number(order.total ?? 0);
    const amountPence = Math.round(basketGbp * 100);
    if (amountPence <= 0) throw new BadRequestException("Order total must be > 0");

    const intentParams: any = {
      amount: amountPence,
      currency: "gbp",
      payment_method_types: ["card_present"],
      capture_method: "automatic",
      metadata: {
        orderId: order.id,
        tenantId: order.tenantId,
        locationId: order.locationId,
        source: "terminal",
        channel: "mobile_reader",
        ...(simulated ? { testDrive: "1" } : {}),
      },
    };

    // Same destination-charge + application-fee routing as the S700 path so
    // the money lands in the location's connected account. SKIPPED for
    // simulated charges — live connected accounts don't exist in test mode.
    if (!simulated) {
      const connect = await this.payments.resolveConnectAccount(
        args.tenantId,
        order.locationId,
        order.brandId,
      );
      if (connect?.stripeAccountId) {
        const feePence = await this.payments.applicationFeePenceForBasket(
          order.locationId,
          basketGbp,
        );
        intentParams.on_behalf_of = connect.stripeAccountId;
        intentParams.transfer_data = { destination: connect.stripeAccountId };
        if (feePence > 0) intentParams.application_fee_amount = feePence;
      }
    }

    const pi = await stripe.paymentIntents.create(intentParams);

    await (this.prisma as any).payment.create({
      data: {
        tenantId: order.tenantId,
        orderId: order.id,
        stripePaymentIntentId: pi.id,
        amount: order.total,
        currency: "gbp",
        status: "PROCESSING",
        method: "CARD",
        metadata: { source: "terminal", channel: "mobile_reader", simulated },
      },
    });

    this.logger.log(
      `Mobile-reader charge prepared${simulated ? " (SIMULATED)" : ""}: order ${order.id} £${basketGbp} (pi ${pi.id})`,
    );
    return {
      paymentIntentId: pi.id,
      clientSecret: pi.client_secret,
      amount: basketGbp,
      currency: "gbp",
      simulated,
    };
  }

  // ── Charge an order on a reader ───────────────────────────────────────────

  /**
   * Charge an order to a card reader.
   *
   * `amount` turns this into a PART payment for split bills ("£20 of
   * this table's £48 on card"). Without it the whole order total is
   * charged, exactly as before. The distinction is carried on the
   * Payment row's metadata as `split: true`, because it changes what
   * settlement means: a part payment must NOT mark the order PAID on
   * its own — only the part that finally covers the balance does. See
   * PaymentsService.settleTerminalPi.
   */
  async chargeOrder(args: {
    tenantId: string;
    orderId: string;
    readerId: string;
    amount?: number;
  }) {
    this.assertStripe();
    const order = await this.prisma.order.findFirst({
      where: { id: args.orderId, tenantId: args.tenantId },
      select: {
        id: true,
        tenantId: true,
        locationId: true,
        brandId: true,
        total: true,
        paymentStatus: true,
      },
    });
    if (!order) throw new NotFoundException("Order not found");
    if (order.paymentStatus === "PAID") {
      throw new BadRequestException("Order is already paid");
    }
    if (!order.locationId) {
      throw new BadRequestException("Order has no location");
    }

    // Verify the reader belongs to this location.
    const loc = await this.loadLocation(args.tenantId, order.locationId);
    const cfg = this.configFrom(loc);
    const reader = cfg.readers.find((r) => r.id === args.readerId);
    if (!reader) throw new NotFoundException("Reader not registered at this location");

    const orderTotalGbp = Number(order.total ?? 0);
    const isSplit = args.amount !== undefined && args.amount !== null;

    // For a split, the ceiling is what's still OWED, not the order
    // total — otherwise two concurrent part-charges could each pass a
    // naive "<= total" check and together overcharge the table.
    let basketGbp = orderTotalGbp;
    if (isSplit) {
      const requested = Math.round(Number(args.amount) * 100) / 100;
      if (!Number.isFinite(requested) || requested <= 0) {
        throw new BadRequestException("Amount must be greater than zero");
      }
      const alreadyPaid = await this.paidSoFarGbp(order.id);
      const remaining = Math.round((orderTotalGbp - alreadyPaid) * 100) / 100;
      if (remaining <= 0) {
        throw new BadRequestException("This bill is already fully paid");
      }
      // A rounding penny of slack, same tolerance as the cash split path.
      if (requested > remaining + 0.01) {
        throw new BadRequestException(
          `That's more than the £${remaining.toFixed(2)} still owed`,
        );
      }
      basketGbp = requested;
    }

    const amountPence = Math.round(basketGbp * 100);
    if (amountPence <= 0) throw new BadRequestException("Order total must be > 0");

    const stripe = this.client(reader.simulated);

    const intentParams: any = {
      amount: amountPence,
      currency: "gbp",
      payment_method_types: ["card_present"],
      capture_method: "automatic",
      metadata: {
        orderId: order.id,
        tenantId: order.tenantId,
        locationId: order.locationId,
        source: "terminal",
        ...(isSplit ? { split: "1" } : {}),
        ...(reader.simulated ? { testDrive: "1" } : {}),
      },
    };

    // Connect routing — same destination-charge model + application fee as
    // online orders. SKIPPED for simulated readers: they run on the TEST
    // client, and live-mode connected accounts don't exist there ("No such
    // account"). The test drive exercises the POS→reader→paid flow, not
    // payout routing.
    if (!reader.simulated) {
      const connect = await this.payments.resolveConnectAccount(
        args.tenantId,
        order.locationId,
        order.brandId,
      );
      if (connect?.stripeAccountId) {
        const feePence = await this.payments.applicationFeePenceForBasket(
          order.locationId,
          basketGbp,
        );
        intentParams.on_behalf_of = connect.stripeAccountId;
        intentParams.transfer_data = { destination: connect.stripeAccountId };
        if (feePence > 0) intentParams.application_fee_amount = feePence;
      }
    }

    const pi = await stripe.paymentIntents.create(intentParams);

    // Push the PaymentIntent to the reader — it prompts the customer.
    await stripe.terminal.readers.processPaymentIntent(args.readerId, {
      payment_intent: pi.id,
    });

    // Persist a Payment row so reconciliation + the webhook can find it.
    await (this.prisma as any).payment.create({
      data: {
        tenantId: order.tenantId,
        orderId: order.id,
        stripePaymentIntentId: pi.id,
        // The PART amount for a split, never the order total — this row
        // is what paymentSummary() sums to decide when the bill is clear.
        amount: basketGbp,
        currency: "gbp",
        status: "PROCESSING",
        method: "CARD",
        metadata: {
          source: "terminal",
          readerId: args.readerId,
          ...(isSplit ? { split: true } : {}),
        },
      },
    });

    this.logger.log(
      `Terminal charge started: order ${order.id} £${basketGbp}` +
        `${isSplit ? ` (split of £${orderTotalGbp})` : ""}` +
        ` on reader ${args.readerId} (pi ${pi.id})`,
    );
    return {
      paymentIntentId: pi.id,
      readerId: args.readerId,
      status: "processing",
      simulated: reader.simulated,
      amount: basketGbp,
    };
  }

  /**
   * Sum of the part-payments already banked against an order. Only
   * SUCCEEDED rows count — a PROCESSING one is a card still in the
   * customer's hand and may yet be declined.
   */
  private async paidSoFarGbp(orderId: string): Promise<number> {
    const rows = await (this.prisma as any).payment.findMany({
      where: { orderId, status: "SUCCEEDED" },
      select: { amount: true },
    });
    const sum = rows.reduce((s: number, p: any) => s + Number(p.amount), 0);
    return Math.round(sum * 100) / 100;
  }

  /** Test drive: play the customer tapping their card on a simulated reader. */
  async simulatePresent(readerId: string) {
    const stripe = this.client(true); // simulated readers live on the test client
    await stripe.testHelpers.terminal.readers.presentPaymentMethod(readerId);
    return { ok: true };
  }

  /**
   * Poll a terminal PaymentIntent. When Stripe reports success we settle it
   * (mark the order PAID) inline — so the POS gets a definitive answer even
   * before the webhook lands. Idempotent with the webhook path.
   *
   * The PI can live on either client (live for real readers, test for the
   * simulated test drive — where no webhook fires at all, making this poll
   * the ONLY settle path), so try live first and fall back to test.
   */
  async status(tenantId: string, paymentIntentId: string) {
    this.assertStripe();
    let pi: any;
    try {
      pi = await this.stripe.paymentIntents.retrieve(paymentIntentId);
    } catch (err) {
      if (!this.stripeTest || this.stripeTest === this.stripe) throw err;
      pi = await this.stripeTest.paymentIntents.retrieve(paymentIntentId);
    }
    if (pi.metadata?.tenantId && pi.metadata.tenantId !== tenantId) {
      throw new NotFoundException("Payment not found");
    }
    if (pi.status === "succeeded") {
      await this.payments.settleTerminalPi(pi);
    }
    return {
      paymentIntentId: pi.id,
      status: pi.status,
      paid: pi.status === "succeeded",
    };
  }
}
