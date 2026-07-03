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
  stripeLocationId: string | null; // tml_…
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

  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
    private readonly payments: PaymentsService,
  ) {
    const key = this.config.get<string>("STRIPE_SECRET_KEY");
    this.stripe = key && Stripe ? new Stripe(key, { apiVersion: "2024-06-20" }) : null;
  }

  private assertStripe() {
    if (!this.stripe) {
      throw new BadRequestException(
        "Stripe isn't configured on the server (missing STRIPE_SECRET_KEY).",
      );
    }
  }

  /** True in Stripe test mode — gates the simulated-reader helpers. */
  get isTestMode(): boolean {
    const key = this.config.get<string>("STRIPE_SECRET_KEY") ?? "";
    return key.startsWith("sk_test") || key.startsWith("rk_test");
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

  private async ensureStripeLocation(
    loc: { id: string; name: string; address: unknown; settings: unknown },
    cfg: TerminalConfig,
  ): Promise<string> {
    if (cfg.stripeLocationId) return cfg.stripeLocationId;
    this.assertStripe();
    const a = (loc.address ?? {}) as Record<string, any>;
    const created = await this.stripe.terminal.locations.create({
      display_name: loc.name || "Order Hub location",
      address: {
        line1: a.line1 || a.addressLine1 || "1 High Street",
        city: a.city || "London",
        postal_code: a.postcode || a.post_code || a.postal_code || "SW1A 1AA",
        country: a.country || "GB",
      },
      metadata: { orderhubLocationId: loc.id },
    });
    cfg.stripeLocationId = created.id;
    await this.saveConfig(loc.id, loc.settings, cfg);
    this.logger.log(`Stripe Terminal location ${created.id} created for ${loc.id}`);
    return created.id;
  }

  // ── Reader registration ───────────────────────────────────────────────────

  async registerReader(args: {
    tenantId: string;
    locationId: string;
    registrationCode: string;
    label?: string;
  }): Promise<StoredReader> {
    this.assertStripe();
    const loc = await this.loadLocation(args.tenantId, args.locationId);
    const cfg = this.configFrom(loc);
    const stripeLocationId = await this.ensureStripeLocation(loc, cfg);

    const reader = await this.stripe.terminal.readers.create({
      registration_code: args.registrationCode.trim(),
      location: stripeLocationId,
      label: args.label?.trim() || "Counter reader",
    });

    const stored: StoredReader = {
      id: reader.id,
      label: reader.label ?? args.label ?? "Counter reader",
      deviceType: reader.device_type ?? null,
      simulated: !!reader.metadata?.simulated || args.registrationCode.includes("simulated"),
      addedAt: new Date().toISOString(),
    };
    cfg.readers = [...cfg.readers.filter((r) => r.id !== stored.id), stored];
    await this.saveConfig(loc.id, loc.settings, cfg);
    this.logger.log(`Reader ${reader.id} registered at location ${loc.id}`);
    return stored;
  }

  /** Convenience: register Stripe's built-in simulated reader (test mode). */
  async registerSimulatedReader(tenantId: string, locationId: string) {
    if (!this.isTestMode) {
      throw new BadRequestException(
        "Simulated readers only work with a Stripe TEST key.",
      );
    }
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
        if (!this.stripe) return { ...r, status: "unknown" };
        try {
          const live = await this.stripe.terminal.readers.retrieve(r.id);
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
    cfg.readers = cfg.readers.filter((r) => r.id !== readerId);
    await this.saveConfig(loc.id, loc.settings, cfg);
    if (this.stripe) {
      await this.stripe.terminal.readers.del(readerId).catch(() => {
        /* already gone / not deletable */
      });
    }
    return { ok: true };
  }

  // ── Charge an order on a reader ───────────────────────────────────────────

  async chargeOrder(args: {
    tenantId: string;
    orderId: string;
    readerId: string;
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

    const basketGbp = Number(order.total ?? 0);
    const amountPence = Math.round(basketGbp * 100);
    if (amountPence <= 0) throw new BadRequestException("Order total must be > 0");

    // Connect routing — same destination-charge model + application fee as
    // online orders. Falls back to a plain platform charge if unconnected.
    const connect = await this.payments.resolveConnectAccount(
      args.tenantId,
      order.locationId,
      order.brandId,
    );

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
      },
    };
    if (connect?.stripeAccountId) {
      const feePence = await this.payments.applicationFeePenceForBasket(
        order.locationId,
        basketGbp,
      );
      intentParams.on_behalf_of = connect.stripeAccountId;
      intentParams.transfer_data = { destination: connect.stripeAccountId };
      if (feePence > 0) intentParams.application_fee_amount = feePence;
    }

    const pi = await this.stripe.paymentIntents.create(intentParams);

    // Push the PaymentIntent to the reader — it prompts the customer.
    await this.stripe.terminal.readers.processPaymentIntent(args.readerId, {
      payment_intent: pi.id,
    });

    // Persist a Payment row so reconciliation + the webhook can find it.
    await (this.prisma as any).payment.create({
      data: {
        tenantId: order.tenantId,
        orderId: order.id,
        stripePaymentIntentId: pi.id,
        amount: order.total,
        currency: "gbp",
        status: "PROCESSING",
        method: "CARD",
        metadata: { source: "terminal", readerId: args.readerId },
      },
    });

    this.logger.log(
      `Terminal charge started: order ${order.id} £${basketGbp} on reader ${args.readerId} (pi ${pi.id})`,
    );
    return {
      paymentIntentId: pi.id,
      readerId: args.readerId,
      status: "processing",
      simulated: reader.simulated,
      amount: basketGbp,
    };
  }

  /** Test-mode only: play the customer tapping their card on a simulated reader. */
  async simulatePresent(readerId: string) {
    this.assertStripe();
    if (!this.isTestMode) {
      throw new BadRequestException("Card simulation only works in Stripe test mode.");
    }
    await this.stripe.testHelpers.terminal.readers.presentPaymentMethod(readerId);
    return { ok: true };
  }

  /**
   * Poll a terminal PaymentIntent. When Stripe reports success we settle it
   * (mark the order PAID) inline — so the POS gets a definitive answer even
   * before the webhook lands. Idempotent with the webhook path.
   */
  async status(tenantId: string, paymentIntentId: string) {
    this.assertStripe();
    const pi = await this.stripe.paymentIntents.retrieve(paymentIntentId);
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
