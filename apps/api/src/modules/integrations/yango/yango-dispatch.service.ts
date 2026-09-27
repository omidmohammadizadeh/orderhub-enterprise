// Phase BK — dispatch an order to a Yango Delivery courier (UAE).
//
// Money rule is the same as Stuart / Uber Direct / JET Go: debit the location
// wallet a flat OrderHub fee BEFORE the claim is created, refund it if the
// courier is never booked, PLATFORM_ADMIN bypasses. Yango bills the shop's own
// business account (the token's) for the courier.
//
// Yango's flow is create → estimate → ACCEPT, and only the last step costs:
//
//   check-price   free quote, no claim. Used for the modal AND re-run on
//                 dispatch, so the accept can be checked against a price the
//                 operator actually saw moments ago.
//   claims/create claim in `new`. Nothing is booked yet. Idempotent on
//                 request_id, so a timeout can be retried without a double claim.
//   (estimating)  asynchronous. Usually seconds; we wait up to ~12s here and the
//                 poller picks up anything slower.
//   claims/accept THIS books a real courier. Done by YangoTrackingService, which
//                 refuses an expired offer or one far above the quote.
//
// There is no sandbox, so a location starts in estimate_only mode: quote works,
// dispatch refuses before anything is created.

import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from "@nestjs/common";
import { randomUUID } from "crypto";
import { ConfigService } from "@nestjs/config";
import {
  coordsFromDeliveryAddress,
  formatDeliveryAddress,
  resolveDeliveryAddress,
} from "@orderhub/shared";
import { PrismaService } from "../../../infrastructure/database/prisma.service";
import { WalletService } from "../../wallet/wallet.service";
import { GeocodingService } from "../../dispatch/geocoding.service";
import { ActivityLogService } from "../../logs/activity-log.service";
import {
  DecryptedYangoConfig,
  YangoConfigService,
  yangoCountrySupported,
} from "./yango-config.service";
import { YangoApiError, YangoClaim, YangoClientService } from "./yango-client.service";
import {
  buildCheckPriceBody,
  buildCreateBody,
  orderRef,
  toYangoPhone,
  YangoRoute,
} from "./yango-payload";
import { decimalOrNull, normStatus } from "./yango-status";
import { YANGO_COURIER_FIELDS_CLEARED, YangoTrackingService } from "./yango-tracking.service";

interface DispatchArgs {
  orderId: string;
  tenantId: string;
  userId?: string | null;
  isAdmin: boolean;
}

/** How long dispatch waits for Yango to finish estimating before handing the
 *  accept to the poller. Long enough for the usual case, short enough that the
 *  operator isn't staring at a spinner. */
const ESTIMATE_WAIT_MS = 12_000;
const ESTIMATE_POLL_MS = 1_500;

@Injectable()
export class YangoDispatchService {
  private readonly logger = new Logger(YangoDispatchService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly wallet: WalletService,
    private readonly config: YangoConfigService,
    private readonly client: YangoClientService,
    private readonly tracking: YangoTrackingService,
    private readonly geocoding: GeocodingService,
    private readonly appConfig: ConfigService,
    @Optional() private readonly activity?: ActivityLogService,
  ) {}

  private db(): any {
    return this.prisma as any;
  }

  private apiBase(): string {
    return (this.appConfig.get<string>("app.apiUrl") ?? "https://orderhub-api-0re6.onrender.com").replace(/\/$/, "");
  }

  /** Overridden in tests so the estimate wait doesn't cost real seconds. */
  private estimateWaitMs(): number {
    return ESTIMATE_WAIT_MS;
  }

  private sleep(ms: number) {
    return new Promise((r) => setTimeout(r, ms));
  }

  private async load(orderId: string, tenantId: string) {
    const order = await this.db().order.findFirst({
      where: { id: orderId, tenantId },
      include: { items: true },
    });
    if (!order) throw new NotFoundException("Order not found");
    const location = order.locationId
      ? await this.db().location.findUnique({ where: { id: order.locationId } })
      : null;
    if (!location) throw new BadRequestException("Order has no location to dispatch from.");
    if (!yangoCountrySupported(location.country)) {
      throw new BadRequestException("Yango Delivery is only available for shops in the UAE.");
    }
    const cfg = await this.config.getDecrypted(order.locationId);
    if (!cfg?.token) {
      throw new BadRequestException(
        "Yango isn't set up for this location. Add the API token in Location settings.",
      );
    }
    if (!cfg.active) {
      throw new BadRequestException(
        "Yango is switched off for this location. Turn it on in Location settings.",
      );
    }
    return { order, location, cfg };
  }

  /** Pickup + drop-off, with coordinates. Yango's docs call coordinates
   *  effectively mandatory; an address string alone won't route. */
  private async route(order: any, location: any, cfg: DecryptedYangoConfig): Promise<YangoRoute> {
    if (cfg.pickupLat == null || cfg.pickupLng == null) {
      throw new BadRequestException(
        "This shop has no pickup point set for Yango. Set it in Location settings → Yango.",
      );
    }
    const parts = resolveDeliveryAddress(order);
    const dropoffAddress = formatDeliveryAddress(parts);
    if (!dropoffAddress) {
      throw new BadRequestException("This order has no delivery address to dispatch to.");
    }
    let lat = Number(order.deliveryLat);
    let lng = Number(order.deliveryLng);
    const bad = () => !Number.isFinite(lat) || !Number.isFinite(lng) || (lat === 0 && lng === 0);
    if (bad()) {
      const fromBlob = coordsFromDeliveryAddress(order.deliveryAddress);
      if (fromBlob) ({ lat, lng } = fromBlob);
    }
    if (bad()) {
      const p = await this.geocoding.geocode(dropoffAddress, "AE");
      if (p) ({ lat, lng } = p);
    }
    if (bad()) {
      throw new BadRequestException(
        "Couldn't find this delivery address on the map, and Yango needs exact coordinates. Check the address.",
      );
    }
    const pickupAddress =
      [location.addressLine1, location.addressLine2, location.city].filter(Boolean).join(", ") ||
      String(location.name ?? "Restaurant");
    return {
      pickup: { lat: cfg.pickupLat, lng: cfg.pickupLng },
      pickupAddress,
      dropoff: { lat, lng },
      dropoffAddress,
    };
  }

  private warnings(order: any): string[] {
    const w: string[] = [];
    if (String(order.paymentMethod ?? "").toUpperCase() === "CASH" && order.paymentStatus !== "PAID") {
      w.push(
        "This is a CASH order. OrderHub never asks a Yango courier to collect cash (Yango hasn't confirmed cash-on-delivery in the UAE) — the customer must already have paid, or you won't be paid for this order.",
      );
    }
    if (order.scheduledFor || order.scheduledAt) {
      w.push("This is a scheduled order. Yango books a courier NOW (ASAP) — dispatch it when the food is nearly ready.");
    }
    return w;
  }

  private async quoteRaw(order: any, location: any, cfg: DecryptedYangoConfig) {
    const route = await this.route(order, location, cfg);
    const res = await this.client.checkPrice(cfg, buildCheckPriceBody(order, route, cfg.taxiClass));
    return { route, res, price: decimalOrNull(res?.price) };
  }

  private humanError(err: any): string {
    if (err instanceof YangoApiError) {
      const map: Record<string, string> = {
        "estimating.claim.no_zone_id": "that address is outside Yango's delivery zone",
        unknown_zone: "that address is outside Yango's delivery zone",
        address_outside_delivery_zone: "that address is outside Yango's delivery zone",
        "estimating.route_too_long": "the route is too long for Yango",
        "errors.suitable_offer_not_found": "Yango has no courier offer for this route right now",
        "estimating.requirement_unavailable": "that courier class isn't available here — try the other one in settings",
        "estimating.tariff.no_categories_in_zone": "that courier class isn't available here — try the other one in settings",
        invalid_phone_must_start_plus_symbol: "a phone number isn't in international format",
        country_phone_code_not_supported: "a phone number's country code isn't supported",
        too_many_requests: "Yango is rate-limiting us — try again in a moment",
      };
      if (err.code && map[err.code]) return map[err.code]!;
    }
    return err?.message ?? "unknown error";
  }

  /** Price + ETA, no claim and no charge. Works in estimate_only mode. */
  async quote(args: { orderId: string; tenantId: string }) {
    const { order, location, cfg } = await this.load(args.orderId, args.tenantId);
    let q;
    try {
      q = await this.quoteRaw(order, location, cfg);
    } catch (err: any) {
      if (err instanceof BadRequestException) throw err;
      throw new BadRequestException(`Yango can't quote this order: ${this.humanError(err)}`);
    }
    return {
      currency: q.res?.currency_rules?.code ?? location.currency ?? "AED",
      amount: q.price,
      etaMinutes: Number.isFinite(Number(q.res?.eta)) ? Number(q.res.eta) : null,
      distanceMeters: Number.isFinite(Number(q.res?.distance_meters)) ? Number(q.res.distance_meters) : null,
      mode: cfg.mode,
      /** estimate_only: the price is real, the dispatch button isn't. */
      canDispatch: cfg.mode === "live",
      dispatchFeeMinor: this.wallet.dispatchFeeMinor(),
      warnings: this.warnings(order),
    };
  }

  async dispatch(args: DispatchArgs) {
    const { order, location, cfg } = await this.load(args.orderId, args.tenantId);
    if (cfg.mode !== "live") {
      throw new BadRequestException(
        "Yango is in estimate-only mode for this shop, so no courier was booked. Switch it to live in Location settings → Yango.",
      );
    }
    if (order.courierProvider === "YANGO" && order.courierJobId) {
      throw new BadRequestException("This order was already dispatched to Yango.");
    }
    if (order.courierProvider && order.courierJobId) {
      throw new BadRequestException(`This order is already with ${order.courierProvider}. Cancel that first.`);
    }

    const currency = String(location.currency ?? "AED").toUpperCase();
    const shopPhone = toYangoPhone(location.phone);
    if (!shopPhone) {
      throw new BadRequestException(
        "Yango needs the shop's phone number in international format (+971…). Add it in Location settings.",
      );
    }
    const customerPhone = toYangoPhone(order.customerPhone);
    if (!customerPhone) {
      throw new BadRequestException(
        "Yango needs the customer's phone number for the courier. Add one to the order before dispatching.",
      );
    }
    if (!cfg.contactEmail) {
      throw new BadRequestException("Add a contact email in Location settings → Yango; Yango requires one.");
    }

    // A fresh quote: the price the accept is checked against.
    let quoted: Awaited<ReturnType<YangoDispatchService["quoteRaw"]>>;
    try {
      quoted = await this.quoteRaw(order, location, cfg);
    } catch (err: any) {
      if (err instanceof BadRequestException) throw err;
      throw new BadRequestException(`Yango can't deliver this order: ${this.humanError(err)}`);
    }

    const feeMinor = this.wallet.dispatchFeeMinor();
    let charged = false;
    if (!args.isAdmin) {
      await this.wallet.debitForDispatch({
        tenantId: args.tenantId,
        locationId: order.locationId,
        orderId: order.id,
        amountMinor: feeMinor,
        createdBy: args.userId ?? null,
      });
      charged = true;
    }

    const requestId = randomUUID();
    const body = buildCreateBody({
      order,
      location,
      route: quoted.route,
      taxiClass: cfg.taxiClass,
      currency,
      contactEmail: cfg.contactEmail,
      shopPhone,
      customerPhone,
      callbackUrl: this.config.webhookUrl(this.apiBase(), cfg.webhookToken),
    });

    let claim: YangoClaim;
    try {
      try {
        claim = await this.client.createClaim(cfg, requestId, body);
      } catch (err: any) {
        // A 5xx or a dropped connection may still have created the claim. The
        // SAME request_id returns that claim instead of making a second one.
        const transient = !(err instanceof YangoApiError) || err.status >= 500;
        if (!transient) throw err;
        claim = await this.client.createClaim(cfg, requestId, body);
      }
      if (!claim?.id) throw new Error("Yango returned no claim id");
    } catch (err: any) {
      if (charged) {
        await this.wallet.refundDispatch({
          tenantId: args.tenantId,
          locationId: order.locationId,
          orderId: order.id,
          amountMinor: feeMinor,
          createdBy: args.userId ?? null,
        });
      }
      this.logger.error(`Yango claim create failed for order ${order.id}: ${err?.message ?? err}`);
      throw new BadRequestException(`Yango couldn't create the delivery: ${this.humanError(err)}`);
    }

    const meta = (order.metadata ?? {}) as Record<string, any>;
    order.metadata = {
      ...meta,
      yango: {
        requestId,
        quotedPrice: quoted.price,
        currency,
        acceptPending: true,
        dispatchedAt: new Date().toISOString(),
        walletFeeMinor: charged ? feeMinor : 0,
        lastStatus: normStatus(claim.status),
      },
    };
    await this.db().order.update({
      where: { id: order.id },
      data: {
        deliveryType: "PLATFORM",
        courierProvider: "YANGO",
        courierJobId: claim.id,
        courierStatus: (normStatus(claim.status) || "new").toUpperCase(),
        metadata: order.metadata,
      },
    });
    order.courierProvider = "YANGO";
    order.courierJobId = claim.id;

    this.activity?.record({
      tenantId: args.tenantId,
      locationId: order.locationId,
      category: "ORDERS",
      channel: "YANGO",
      action: "courier.dispatch",
      status: "SUCCESS",
      message: `Order ${orderRef(order)} sent to Yango — booking a courier`,
      details: {
        claimId: claim.id,
        quotedPrice: quoted.price,
        currency,
        walletFeeMinor: charged ? feeMinor : 0,
      },
    });

    // Wait for the estimate; accept (or refuse) as soon as it lands.
    let latest: YangoClaim = claim;
    let outcome: any = null;
    const deadline = Date.now() + this.estimateWaitMs();
    while (Date.now() < deadline) {
      const st = normStatus(latest.status);
      if (st !== "new" && st !== "estimating") {
        outcome = await this.tracking.apply(order, latest, cfg);
        break;
      }
      await this.sleep(ESTIMATE_POLL_MS);
      try {
        latest = await this.client.claimInfo(cfg, claim.id);
      } catch (err: any) {
        this.logger.warn(`Yango claims/info during dispatch failed: ${err?.message ?? err}`);
      }
    }

    const fresh = await this.db().order.findUnique({ where: { id: order.id } });
    if (!fresh?.courierJobId) {
      // Abandoned inside apply (estimating_failed, price too high, …).
      const reason = (fresh?.metadata as any)?.yango?.lastError ?? "the courier could not be booked.";
      throw new BadRequestException(`Yango didn't book a courier: ${reason}`);
    }
    const accepted = Boolean((fresh.metadata as any)?.yango?.acceptedAt);

    this.logger.log(
      `Yango dispatch order=${order.id} claim=${claim.id} quoted=${quoted.price} ${currency} accepted=${accepted} fee=${args.isAdmin ? "0 (admin bypass)" : feeMinor}`,
    );
    return {
      ok: true,
      jobId: claim.id,
      status: fresh.courierStatus,
      accepted,
      /** Not yet accepted = Yango is still pricing; the poller books it within
       *  seconds, and refuses it (refunding the fee) if the price jumped. */
      pending: !accepted,
      quotedPrice: quoted.price,
      currency,
      outcome: outcome?.reason ?? null,
      feeChargedMinor: charged ? feeMinor : 0,
      adminBypass: args.isAdmin,
      warnings: this.warnings(order),
    };
  }

  /**
   * Cancel. Yango's rules: FREE until the courier reaches the shop, PAID between
   * arriving and collecting, impossible (support only) once collected. A paid
   * cancel needs `confirmPaid` — the first call returns the fee so the operator
   * can decide, rather than being charged by surprise.
   */
  async cancel(args: { orderId: string; tenantId: string; confirmPaid?: boolean }) {
    const order = await this.db().order.findFirst({ where: { id: args.orderId, tenantId: args.tenantId } });
    if (!order) throw new NotFoundException("Order not found");
    if (order.courierProvider !== "YANGO" || !order.courierJobId) {
      throw new BadRequestException("This order isn't on a Yango courier.");
    }
    const cfg = await this.config.getDecrypted(order.locationId);
    if (!cfg?.token) throw new BadRequestException("Yango credentials for this location are missing.");

    const info = await this.client.cancelInfo(cfg, order.courierJobId);
    const state = String(info?.cancel_state ?? "");
    if (state === "unavailable") {
      throw new BadRequestException(
        "Yango won't cancel this delivery through the API any more — the courier has the food. Contact Yango support.",
      );
    }
    if (state === "paid" && !args.confirmPaid) {
      return {
        ok: false,
        needsConfirmation: true,
        cancelState: "paid",
        fee: decimalOrNull(info.price_with_vat ?? info.price),
        currency: info.currency ?? null,
        message:
          "The courier has already reached the shop, so Yango charges for cancelling now. Confirm to cancel and pay that fee.",
      };
    }
    const claim = await this.client.claimInfo(cfg, order.courierJobId);
    try {
      await this.client.cancelClaim(cfg, order.courierJobId, claim.version, state || "free");
    } catch (err: any) {
      if (err instanceof YangoApiError && err.code === "free_cancel_is_unavailable") {
        throw new BadRequestException(
          "The free cancellation window just closed (the courier arrived). Try again to see the fee.",
        );
      }
      throw new BadRequestException(`Yango wouldn't cancel this delivery: ${this.humanError(err)}`);
    }

    // Yango's cancel is synchronous, so clear now. Clearing courierProvider also
    // stops the poller treating the later `cancelled` status as a cancellation
    // made elsewhere. No fee refund: operator cancels are not refunded, or
    // cancel/re-dispatch would be a free loop.
    const meta = (order.metadata ?? {}) as Record<string, any>;
    await this.db().order.update({
      where: { id: order.id },
      data: {
        ...YANGO_COURIER_FIELDS_CLEARED,
        metadata: { ...meta, yango: { ...(meta.yango ?? {}), acceptPending: false, cancelledAt: new Date().toISOString(), cancelState: state } },
      },
    });
    this.activity?.record({
      tenantId: order.tenantId,
      locationId: order.locationId,
      category: "ORDERS",
      channel: "YANGO",
      action: "courier.cancelled",
      status: "INFO",
      message: `Yango delivery for order ${orderRef(order)} cancelled${state === "paid" ? " (with Yango's cancellation fee)" : ""}.`,
      details: { claimId: order.courierJobId, cancelState: state },
    });
    return {
      ok: true,
      cancelState: state,
      message:
        state === "paid"
          ? "Cancelled. Yango will charge its cancellation fee to your Yango account."
          : "Cancelled — you can dispatch again.",
    };
  }

  /** Re-read the claim now and apply it — the operator's "refresh" button. */
  async refreshStatus(args: { orderId: string; tenantId: string }) {
    const order = await this.db().order.findFirst({ where: { id: args.orderId, tenantId: args.tenantId } });
    if (!order) throw new NotFoundException("Order not found");
    if (order.courierProvider !== "YANGO" || !order.courierJobId) {
      throw new BadRequestException("This order isn't on a Yango courier.");
    }
    const cfg = await this.config.getDecrypted(order.locationId);
    if (!cfg?.token) throw new BadRequestException("Yango credentials for this location are missing.");
    const claim = await this.client.claimInfo(cfg, order.courierJobId);
    const res = await this.tracking.apply(order, claim, cfg);
    return { ok: true, status: normStatus(claim.status) || null, result: res };
  }

  /** Settings-screen check: proves the token works AND the shop's pickup point
   *  sits in a Yango zone, and lists the classes Yango runs there. Free. */
  async verify(locationId: string, tenantId: string) {
    const pub = await this.config.getPublicConfig(locationId, tenantId, this.apiBase());
    const cfg = await this.config.getDecrypted(locationId);
    if (!cfg?.token || !pub.configured) return { ok: false, message: "Add your Yango API token first." };
    if (cfg.pickupLat == null || cfg.pickupLng == null) {
      return { ok: false, message: "Set the pickup point first." };
    }
    try {
      const res = await this.client.tariffs(cfg, { lat: cfg.pickupLat, lng: cfg.pickupLng });
      // Shape isn't pinned down in the docs; collect every class name we see.
      const found = new Set<string>();
      const walk = (v: any) => {
        if (!v || typeof v !== "object") return;
        if (Array.isArray(v)) return v.forEach(walk);
        for (const [k, val] of Object.entries(v)) {
          if ((k === "taxi_class" || k === "name") && typeof val === "string") found.add(val);
          else walk(val);
        }
      };
      walk(res);
      const classes = [...found];
      return {
        ok: true,
        classes,
        classAvailable: classes.length === 0 || classes.includes(cfg.taxiClass),
        message: classes.length
          ? `Token works. Yango runs ${classes.join(", ")} at this shop.`
          : "Token works and the shop is inside a Yango zone.",
      };
    } catch (err: any) {
      return { ok: false, message: this.humanError(err) };
    }
  }
}
