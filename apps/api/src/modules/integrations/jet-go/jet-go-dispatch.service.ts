// Phase BJ — dispatch an order to a JET Go courier.
//
// Money rule is the same as Stuart and Uber Direct: debit the location wallet a
// flat OrderHub fee BEFORE the delivery is created, refund it if creation fails,
// PLATFORM_ADMIN bypasses. JET bills the restaurant's own JET Go account for the
// courier itself.
//
// JET Go's flow is two calls, not one, and the order matters:
//
//   POST /estimate  → requestId + price. MANDATORY: there is no way to book a
//                     delivery without one, so unlike Uber Direct we cannot fall
//                     back to "create it anyway" when the quote fails.
//   POST /delivery  → books the courier against that requestId. The requestId
//                     dies after 5 minutes and is single-use, so dispatch always
//                     takes a FRESH estimate rather than reusing the one the
//                     operator saw in the modal.
//
// Both /delivery (202) and /cancellation-request (200) are acknowledgements, not
// outcomes. JET's certification explicitly requires that we treat DELIVERYCREATED
// and CANCELJOBSTATUS as the confirmation, so this service leaves the order in a
// pending-ish courierStatus and lets the webhook settle it.

import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from "@nestjs/common";
import {
  coordsFromDeliveryAddress,
  formatDeliveryAddress,
  resolveDeliveryAddress,
} from "@orderhub/shared";
import { PrismaService } from "../../../infrastructure/database/prisma.service";
import { WalletService } from "../../wallet/wallet.service";
import { GeocodingService } from "../../dispatch/geocoding.service";
import { ActivityLogService } from "../../logs/activity-log.service";
import { JetGoConfigService, DecryptedJetGoConfig } from "./jet-go-config.service";
import {
  JetGoClientService,
  JetGoDeliveryBody,
  JetGoEstimateBody,
  JetGoEstimateResponse,
  JET_GO_EU_COUNTRIES,
} from "./jet-go-client.service";

interface DispatchArgs {
  orderId: string;
  tenantId: string;
  userId?: string | null;
  isAdmin: boolean;
}

/** JET's own bounds on deliveryDetails.preparationDuration. */
const PREP_MIN = 5;
const PREP_MAX = 60;
/** An advance order must be 1 hour–5 days out; anything nearer is an ASAP job. */
const ADVANCE_MIN_MS = 60 * 60 * 1000;
const ADVANCE_MAX_MS = 5 * 24 * 60 * 60 * 1000;

@Injectable()
export class JetGoDispatchService {
  private readonly logger = new Logger(JetGoDispatchService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly wallet: WalletService,
    private readonly config: JetGoConfigService,
    private readonly client: JetGoClientService,
    private readonly geocoding: GeocodingService,
    @Optional() private readonly activity?: ActivityLogService,
  ) {}

  private db(): any {
    return this.prisma as any;
  }

  private str(v: unknown): string {
    return typeof v === "string" ? v.trim() : "";
  }

  /** JET caps most address strings, and a 400 for a long line is a silly way to
   *  lose a delivery. */
  private cap(v: string, max: number): string {
    return v.length > max ? v.slice(0, max) : v;
  }

  /** Where this order is going, via the shared resolver. An order carries its
   *  address in TWO places and usually only one of them: the till fills the
   *  structured columns, and ingestCanonical (every online and marketplace
   *  order) fills only the JSON blob. Reading just the blob here would have
   *  refused to dispatch any order taken at the till. */
  private addressParts(order: any) {
    const parts = resolveDeliveryAddress(order);
    const blob = (order?.deliveryAddress ?? {}) as Record<string, any>;
    return {
      street: [parts.line1, parts.line2].filter(Boolean).join(", "),
      city: parts.city ?? "",
      postcode: parts.postcode ?? "",
      // JET's `province` is a county/state. Only the blob ever carries one.
      province: this.str(blob.province ?? blob.county ?? blob.state ?? blob.region),
      full: formatDeliveryAddress(parts),
    };
  }

  /** Minutes the kitchen needs, clamped into the 5–60 window JET accepts. An
   *  out-of-range value is a 400 on the estimate, which reads to the operator as
   *  "JET Go is down" rather than "your prep time is 90 minutes". */
  private prepMinutes(order: any, location: any): number {
    const raw = Number(order?.preparationMinutes ?? location?.prepTime ?? 20);
    const n = Number.isFinite(raw) ? Math.round(raw) : 20;
    return Math.min(Math.max(n, PREP_MIN), PREP_MAX);
  }

  /** A weight JET can plan a vehicle around. We don't hold per-item weights, so
   *  this is an honest estimate from the line count rather than a fake precision:
   *  ~500g per unit, floored at 500g. */
  private weightGrams(order: any): number {
    const items = Array.isArray(order?.items) ? order.items : [];
    const units = items.reduce(
      (sum: number, it: any) => sum + Math.max(Number(it?.quantity ?? 1) || 1, 1),
      0,
    );
    return Math.max(units * 500, 500);
  }

  private isEuMarket(cfg: DecryptedJetGoConfig, location: any): boolean {
    if (String(cfg.market ?? "").toUpperCase() === "EU") return true;
    return JET_GO_EU_COUNTRIES.includes(String(location?.country ?? "").toUpperCase());
  }

  /** Human-readable reference. JET shows this to the courier at pickup and the
   *  spec explicitly asks for something that is NOT a UUID. */
  private vendorOrderId(order: any): string {
    const ref = this.str(order?.displayId) || (order?.orderNumber != null ? String(order.orderNumber) : "");
    return this.cap(ref || String(order?.id ?? "").slice(-8).toUpperCase(), 64);
  }

  /** An advance order, only when the slot is genuinely 1h–5d out AND the market
   *  supports it. EU markets don't, so those fall back to ASAP. */
  private advanceDeliverTime(order: any, isEu: boolean): string | null {
    if (isEu) return null;
    const when = order?.scheduledFor ?? order?.scheduledAt;
    if (!when) return null;
    const t = new Date(when).getTime();
    if (!Number.isFinite(t)) return null;
    const delta = t - Date.now();
    if (delta < ADVANCE_MIN_MS || delta > ADVANCE_MAX_MS) return null;
    return new Date(t).toISOString();
  }

  private async buildEstimateBody(
    order: any,
    location: any,
    cfg: DecryptedJetGoConfig,
  ): Promise<{ body: JetGoEstimateBody; warnings: string[] }> {
    const warnings: string[] = [];
    if (!cfg.collectPointId) {
      throw new BadRequestException(
        "This location has no JET Go collect point chosen. Pick one in Location settings → JET Go.",
      );
    }
    const drop = this.addressParts(order);
    if (!drop.street && !drop.postcode) {
      throw new BadRequestException("This order has no delivery address to dispatch to.");
    }
    if (!drop.city) {
      // JET requires city, and it is the one required field a UK address often
      // omits because the postcode implies it.
      throw new BadRequestException(
        "This order's delivery address has no town/city, which JET Go requires. Add it to the order before dispatching.",
      );
    }
    const phone = this.str(order.customerPhone);
    if (!phone) {
      throw new BadRequestException(
        "JET Go needs a customer phone number for the courier to call. Add one to the order before dispatching.",
      );
    }
    const info = (order.customerInfo ?? {}) as Record<string, any>;
    const email =
      this.str(info.email) ||
      process.env.JET_GO_FALLBACK_EMAIL ||
      "noreply@orderhubsolutions.com";

    const isEu = this.isEuMarket(cfg, location);

    // Coordinates. Mandatory in EU markets, useful everywhere. Prefer the ones
    // ingest already geocoded; only reach for the geocoder if we have none.
    let lat = Number(order.deliveryLat);
    let lng = Number(order.deliveryLng);
    const bad = () =>
      !Number.isFinite(lat) || !Number.isFinite(lng) || (lat === 0 && lng === 0);
    if (bad()) {
      // Free and exact when the marketplace already sent a point.
      const fromBlob = coordsFromDeliveryAddress(order.deliveryAddress);
      if (fromBlob) {
        lat = fromBlob.lat;
        lng = fromBlob.lng;
      }
    }
    if (bad()) {
      const point = await this.geocoding.geocode(drop.full, location.country ?? "GB");
      if (point) {
        lat = point.lat;
        lng = point.lng;
      }
    }
    const haveCoords = !bad();
    if (!haveCoords && isEu) {
      throw new BadRequestException(
        "JET Go needs coordinates for this delivery address in this market, and we couldn't resolve any. Check the address.",
      );
    }

    const prep = this.prepMinutes(order, location);
    const advance = this.advanceDeliverTime(order, isEu);
    if (!advance && (order.scheduledFor || order.scheduledAt)) {
      warnings.push(
        isEu
          ? "This is a scheduled order, but JET Go doesn't take advance orders in this market — it will be dispatched as ASAP."
          : "This order's slot is under an hour away (or over 5 days out), so JET Go will treat it as ASAP.",
      );
    }

    // Alcohol. We have no per-item alcohol flag, so we only claim it when the
    // order explicitly says so — and we never claim the opposite is verified.
    const meta = (order.metadata ?? {}) as Record<string, any>;
    const hasAlcohol = meta.hasAlcohol === true;

    const body: JetGoEstimateBody = {
      collect: { id: cfg.collectPointId },
      delivery: {
        name: this.cap(this.str(order.customerName) || "Customer", 100),
        emailAddress: this.cap(email, 100),
        phoneNumber: this.cap(phone, 40),
        address: this.cap(drop.street || drop.postcode, 255),
        city: this.cap(drop.city, 50),
        ...(drop.province ? { province: this.cap(drop.province, 50) } : {}),
        ...(drop.postcode ? { postalCode: this.cap(drop.postcode, 15) } : {}),
        ...(haveCoords
          ? {
              geolocation: {
                // [latitude, longitude] — JET's order, not GeoJSON's.
                coordinates: [lat, lng] as [number, number],
                type: "point" as const,
              },
            }
          : {}),
      },
      deliveryDetails: {
        weightGrams: this.weightGrams(order),
        // Only meaningful for ASAP; JET ignores it on an advance order but
        // accepts it, and sending it keeps one code path.
        preparationDuration: prep,
        hasAlcohol,
        ...(hasAlcohol ? { ageRestriction: 18 } : {}),
      },
      deliveryOptions: {
        // A courier who can't find the customer should hand the food back rather
        // than leave a paid order on a doorstep we can't prove.
        ...(isEu ? {} : { unreachablePreference: "RETURN" as const }),
        dropoffAction: "MEET_AT_DOOR" as const,
      },
      ...(advance ? { targetDeliverTime: advance } : {}),
    };

    // Cash on delivery only exists in Bulgaria. Everywhere else a cash order
    // sent to a JET courier means nobody collects the money, so say so loudly
    // rather than quietly dispatching it.
    if (String(order.paymentMethod ?? "").toUpperCase() === "CASH") {
      warnings.push(
        "This is a CASH order. A JET Go courier will not collect cash — the customer must already have paid, or you will not be paid for this order.",
      );
    }

    return { body, warnings };
  }

  private buildDeliveryBody(
    order: any,
    estimate: JetGoEstimateResponse,
    advanceCollectTime: string | null,
  ): JetGoDeliveryBody {
    const totalMinor = Math.max(Math.round(Number(order.total ?? 0) * 100), 0);
    return {
      requestId: estimate.requestId,
      ...(order.specialInstructions
        ? { specialInstructions: this.cap(this.str(order.specialInstructions), 255) }
        : {}),
      ...(advanceCollectTime ? { targetCollectTime: advanceCollectTime } : {}),
      // Deliberately no `tip`. Order.tipAmount is the RESTAURANT's gratuity, and
      // passing it here would hand the shop's money to the courier.
      orderValue: totalMinor,
      vendorOrderId: this.vendorOrderId(order),
      paymentType: "PREPAID",
      // Echoed back on every webhook, which is what lets the handler recover an
      // order even if the requestId lookup ever misses. Values cap at 255.
      metadata: {
        orderId: String(order.id),
        locationId: String(order.locationId ?? ""),
        tenantId: String(order.tenantId ?? ""),
      },
    };
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
    const cfg = await this.config.getDecrypted(order.locationId);
    if (!cfg) {
      throw new BadRequestException(
        "JET Go isn't set up for this location. Add the credentials in Location settings.",
      );
    }
    if (!cfg.active) {
      throw new BadRequestException(
        "JET Go is switched off for this location. Turn it on in Location settings.",
      );
    }
    return { order, location, cfg };
  }

  /** Price + availability, no booking and no charge. Burns a requestId (they
   *  expire in 5 minutes on their own), which is why dispatch re-estimates. */
  async quote(args: { orderId: string; tenantId: string }) {
    const { order, location, cfg } = await this.load(args.orderId, args.tenantId);
    const { body, warnings } = await this.buildEstimateBody(order, location, cfg);
    const est = await this.client.estimate(cfg, body);
    const feeMinor = Number(est?.dynamicDeliveryFee);
    return {
      currency: location.currency ?? "GBP",
      amount: Number.isFinite(feeMinor) ? feeMinor / 100 : null,
      quoteId: est?.requestId ?? null,
      feeRule: est?.dynamicDeliveryFeeRule ?? null,
      collectBy: est?.estimatedEarliestCollectTime ?? est?.targetCollectTime ?? null,
      deliverBy: est?.estimatedEarliestDeliverTime ?? est?.targetDeliverTime ?? null,
      dispatchFeeMinor: this.wallet.dispatchFeeMinor(),
      warnings,
      raw: est,
    };
  }

  async dispatch(args: DispatchArgs) {
    const { order, location, cfg } = await this.load(args.orderId, args.tenantId);
    if (order.courierProvider === "JET_GO" && order.courierJobId) {
      throw new BadRequestException("This order was already dispatched to JET Go.");
    }

    // A fresh estimate every time: the requestId expires in 5 minutes and cannot
    // be reused, so the one behind the price in the modal is not bookable.
    const { body, warnings } = await this.buildEstimateBody(order, location, cfg);
    let estimate: JetGoEstimateResponse;
    try {
      estimate = await this.client.estimate(cfg, body);
    } catch (err: any) {
      // 404 DELIVERY_UNAVAILABLE_ERROR is JET saying "not to that address", which
      // is an operator-actionable answer, not a fault.
      this.logger.warn(
        `JET Go estimate failed for order ${order.id}: ${err?.message ?? err}`,
      );
      throw new BadRequestException(
        `JET Go can't deliver this order: ${err?.message ?? "no estimate available"}`,
      );
    }
    if (!estimate?.requestId) {
      throw new BadRequestException("JET Go returned an estimate with no requestId.");
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

    const advanceCollect = estimate.targetCollectTime ?? null;
    try {
      await this.client.createDelivery(
        cfg,
        this.buildDeliveryBody(order, estimate, advanceCollect),
      );
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
      this.logger.error(`JET Go dispatch failed for order ${order.id}: ${err?.message ?? err}`);
      throw new BadRequestException(
        `JET Go couldn't create the delivery: ${err?.message ?? "unknown error"}`,
      );
    }

    const etaAt = this.asDate(estimate.estimatedEarliestDeliverTime ?? estimate.targetDeliverTime);
    const pickupEtaAt = this.asDate(
      estimate.estimatedEarliestCollectTime ?? estimate.targetCollectTime,
    );

    await this.db().order.update({
      where: { id: order.id },
      data: {
        deliveryType: "PLATFORM",
        courierProvider: "JET_GO",
        // requestId is JET Go's identifier for the whole delivery — it is what
        // cancel, status and every webhook key off, so it is the job id here.
        courierJobId: estimate.requestId,
        // /delivery returns 202 (accepted), not created. DELIVERYCREATED is the
        // confirmation, and JET's certification checks that we wait for it.
        courierStatus: "PENDING",
        ...(etaAt ? { courierEtaAt: etaAt } : {}),
        ...(pickupEtaAt ? { courierPickupEtaAt: pickupEtaAt } : {}),
      },
    });

    this.activity?.record({
      tenantId: args.tenantId,
      locationId: order.locationId,
      category: "ORDERS",
      channel: "JET_GO",
      action: "courier.dispatch",
      status: "SUCCESS",
      message: `Order ${this.vendorOrderId(order)} sent to a JET Go courier`,
      details: {
        requestId: estimate.requestId,
        courierFeeMinor: estimate.dynamicDeliveryFee ?? null,
        feeRule: estimate.dynamicDeliveryFeeRule ?? null,
        walletFeeMinor: args.isAdmin ? 0 : feeMinor,
      },
    });

    this.logger.log(
      `JET Go dispatch OK order=${order.id} requestId=${estimate.requestId} courierFee=${estimate.dynamicDeliveryFee}p fee=${args.isAdmin ? "0 (admin bypass)" : `${feeMinor}p`}`,
    );

    return {
      ok: true,
      jobId: estimate.requestId,
      status: "PENDING",
      trackingUrl: null as string | null,
      courierFeeMinor: estimate.dynamicDeliveryFee ?? null,
      collectBy: estimate.estimatedEarliestCollectTime ?? estimate.targetCollectTime ?? null,
      deliverBy: estimate.estimatedEarliestDeliverTime ?? estimate.targetDeliverTime ?? null,
      feeChargedMinor: args.isAdmin ? 0 : feeMinor,
      adminBypass: args.isAdmin,
      warnings,
    };
  }

  private asDate(v: unknown): Date | null {
    if (!v || typeof v !== "string") return null;
    const d = new Date(v);
    return Number.isFinite(d.getTime()) ? d : null;
  }

  /** Ask JET to cancel. We deliberately do NOT clear the courier fields here:
   *  JET can refuse (the courier may already have collected), and certification
   *  requires that CANCELJOBSTATUS is what confirms it. The webhook clears. */
  async cancel(args: { orderId: string; tenantId: string }) {
    const order = await this.db().order.findFirst({
      where: { id: args.orderId, tenantId: args.tenantId },
    });
    if (!order) throw new NotFoundException("Order not found");
    if (order.courierProvider !== "JET_GO" || !order.courierJobId) {
      throw new BadRequestException("This order isn't on a JET Go courier.");
    }
    const cfg = await this.config.getDecrypted(order.locationId);
    if (!cfg) {
      throw new BadRequestException("JET Go credentials for this location are missing.");
    }
    let message = "Cancellation requested.";
    try {
      const res = await this.client.cancelDelivery(cfg, order.courierJobId);
      message = this.str(res?.message) || message;
    } catch (err: any) {
      this.logger.warn(
        `JET Go cancel refused for request ${order.courierJobId}: ${err?.message ?? err}`,
      );
      throw new BadRequestException(
        `JET Go wouldn't cancel this delivery: ${err?.message ?? "unknown error"}`,
      );
    }
    await this.db().order.update({
      where: { id: order.id },
      data: { courierStatus: "CANCELLATION_REQUESTED" },
    });
    return {
      ok: true,
      pending: true,
      message: `${message} The order stays with the courier until JET Go confirms.`,
    };
  }

  /** Staging-only: walk the delivery through the real webhook sequence so the
   *  whole integration can be proved before JET's certification call. */
  async simulate(args: {
    orderId: string;
    tenantId: string;
    deliveryStep?: string;
    stepWaitDuration?: number;
  }) {
    const order = await this.db().order.findFirst({
      where: { id: args.orderId, tenantId: args.tenantId },
    });
    if (!order) throw new NotFoundException("Order not found");
    if (order.courierProvider !== "JET_GO" || !order.courierJobId) {
      throw new BadRequestException("Dispatch this order to JET Go first, then simulate it.");
    }
    const cfg = await this.config.getDecrypted(order.locationId);
    if (!cfg) throw new BadRequestException("JET Go credentials for this location are missing.");
    if (cfg.environment === "production") {
      throw new BadRequestException(
        "Delivery simulation only exists in the JET Go sandbox — this location is on production.",
      );
    }
    const res = await this.client.simulate(cfg, {
      requestId: order.courierJobId,
      ...(args.deliveryStep ? { deliveryStep: args.deliveryStep } : {}),
      ...(Number.isFinite(Number(args.stepWaitDuration))
        ? { stepWaitDuration: Number(args.stepWaitDuration) }
        : {}),
    });
    return { ok: true, requestId: order.courierJobId, message: res?.message ?? null };
  }

  /** Poll JET for the current status — the manual recovery path when a webhook
   *  was missed (JET does not retry failed webhooks). */
  async refreshStatus(args: { orderId: string; tenantId: string }) {
    const order = await this.db().order.findFirst({
      where: { id: args.orderId, tenantId: args.tenantId },
    });
    if (!order) throw new NotFoundException("Order not found");
    if (order.courierProvider !== "JET_GO" || !order.courierJobId) {
      throw new BadRequestException("This order isn't on a JET Go courier.");
    }
    const cfg = await this.config.getDecrypted(order.locationId);
    if (!cfg) throw new BadRequestException("JET Go credentials for this location are missing.");
    const res = await this.client.deliveryStatus(cfg, order.courierJobId);
    return { ok: true, status: res?.status ?? null, raw: res };
  }
}
