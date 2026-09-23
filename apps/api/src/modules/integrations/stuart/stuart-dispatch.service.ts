// Phase BH — dispatch an order to a Stuart courier.
//
// Money rule: OrderHub charges the location wallet a flat fee (default 50p) per
// dispatch. The wallet is debited BEFORE we create the Stuart job and refunded
// if job creation fails, so we never dispatch for free and never charge for a
// failed dispatch. PLATFORM_ADMIN bypasses the wallet entirely (test flow).
// Stuart bills the restaurant's own account for the actual courier cost.

import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from "@nestjs/common";
import { PrismaService } from "../../../infrastructure/database/prisma.service";
import { WalletService } from "../../wallet/wallet.service";
import { resolveOrderScope } from "../../orders/order-access";
import type { AuthenticatedUser } from "../../auth/interfaces/jwt-payload.interface";
import { StuartConfigService } from "./stuart-config.service";
import {
  StuartClientService,
  StuartJobPayload,
} from "./stuart-client.service";

interface DispatchArgs {
  orderId: string;
  tenantId: string;
  userId?: string | null;
  isAdmin: boolean;
}

// Stuart: "you can send up to 8 deliveries with one courier". One pickup, many
// dropoffs, and Stuart reorders the dropoffs into the best route itself.
export const STUART_MAX_DROPOFFS = 8;

// An order can go on a courier once the shop has taken it and until it has
// one. PENDING hasn't been accepted; everything past READY already has a
// courier or a driver, or has finished.
const BULK_DISPATCHABLE = new Set(["ACCEPTED", "PREPARING", "READY"]);

/** Fulfillment types a courier can carry. PICKUP and DINE_IN are not. */
const DISPATCHABLE_FULFILLMENTS = [
  "DELIVERY",
  "MERCHANT_DELIVERY",
  "PLATFORM_COURIER",
];

@Injectable()
export class StuartDispatchService {
  private readonly logger = new Logger(StuartDispatchService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly wallet: WalletService,
    private readonly config: StuartConfigService,
    private readonly client: StuartClientService,
  ) {}

  private db(): any {
    return this.prisma as any;
  }

  private addressString(
    a: Record<string, any> | null | undefined,
    fallbackParts: Array<string | null | undefined> = [],
  ): string {
    const parts = a
      ? [
          a.line1 ?? a.addressLine1 ?? a.address_1 ?? a.street,
          a.line2 ?? a.addressLine2 ?? a.address_2,
          a.city ?? a.town,
          a.postcode ?? a.postal_code ?? a.zip,
        ]
      : fallbackParts;
    return parts
      .map((p) => (typeof p === "string" ? p.trim() : ""))
      .filter(Boolean)
      .join(", ");
  }

  private splitName(name: string | null | undefined): {
    firstname: string;
    lastname: string;
  } {
    const clean = (name ?? "").trim();
    if (!clean) return { firstname: "Customer", lastname: "" };
    const bits = clean.split(/\s+/);
    return {
      firstname: bits[0] ?? "Customer",
      lastname: bits.slice(1).join(" "),
    };
  }

  /** Build the Stuart pickup(location) → dropoff(customer) job payload. */
  private buildPayload(order: any, location: any): StuartJobPayload {
    const pickupAddress = this.addressString(null, [
      location.addressLine1,
      location.addressLine2,
      location.city,
      location.postcode,
    ]);
    const dropoffAddress = this.addressString(
      order.deliveryAddress as Record<string, any> | null,
    );
    if (!pickupAddress) {
      throw new BadRequestException(
        "This location has no address set — add it in Location settings before dispatching.",
      );
    }
    if (!dropoffAddress) {
      throw new BadRequestException(
        "This order has no delivery address to dispatch to.",
      );
    }
    const cust = this.splitName(order.customerName);
    return {
      job: {
        pickups: [
          {
            address: pickupAddress,
            comment: `Order ${order.displayId ?? order.orderNumber ?? order.id}`,
            contact: {
              firstname: location.name ?? "Restaurant",
              lastname: "",
              phone: location.phone ?? undefined,
              company: location.name ?? undefined,
            },
          },
        ],
        dropoffs: [
          {
            package_type: "medium",
            client_reference: String(
              order.displayId ?? order.orderNumber ?? order.id,
            ),
            address: dropoffAddress,
            contact: {
              firstname: cust.firstname,
              lastname: cust.lastname,
              phone: order.customerPhone ?? undefined,
            },
          },
        ],
      },
    };
  }

  /** Optional pre-flight quote (no wallet charge, no job created). */
  async quote(args: { orderId: string; tenantId: string }) {
    const { order, location, cfg } = await this.load(args.orderId, args.tenantId);
    const pricing = await this.client.pricing(cfg, this.buildPayload(order, location));
    return {
      currency: pricing?.currency ?? "GBP",
      amount: pricing?.amount ?? pricing?.price_tax_included ?? null,
      dispatchFeeMinor: this.wallet.dispatchFeeMinor(),
      raw: pricing,
    };
  }

  private async load(orderId: string, tenantId: string) {
    const order = await this.db().order.findFirst({
      where: { id: orderId, tenantId },
    });
    if (!order) throw new NotFoundException("Order not found");
    const location = order.locationId
      ? await this.db().location.findUnique({ where: { id: order.locationId } })
      : null;
    if (!location) {
      throw new BadRequestException("Order has no location to dispatch from.");
    }
    const cfg = await this.config.getDecrypted(order.locationId);
    if (!cfg) {
      throw new BadRequestException(
        "Stuart isn't set up for this location. Add the client ID/secret in Location settings.",
      );
    }
    if (!cfg.active) {
      throw new BadRequestException(
        "Stuart dispatch is switched off for this location. Turn it on in Location settings.",
      );
    }
    return { order, location, cfg };
  }

  async dispatch(args: DispatchArgs) {
    const { order, location, cfg } = await this.load(args.orderId, args.tenantId);

    if (order.courierProvider === "STUART" && order.courierJobId) {
      throw new BadRequestException(
        "This order was already dispatched to Stuart.",
      );
    }

    const payload = this.buildPayload(order, location);
    const feeMinor = this.wallet.dispatchFeeMinor();

    // Charge the wallet FIRST (unless admin) so an unfunded dispatch is blocked
    // atomically; refund if the Stuart job then fails to create.
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

    let job: any;
    try {
      job = await this.client.createJob(cfg, payload);
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
      this.logger.error(
        `Stuart dispatch failed for order ${order.id}: ${err?.message ?? err}`,
      );
      throw new BadRequestException(
        `Stuart couldn't create the delivery: ${err?.message ?? "unknown error"}`,
      );
    }

    // Stuart returns the job with nested deliveries; pull the first delivery's
    // tracking + status for the board.
    const delivery = Array.isArray(job?.deliveries) ? job.deliveries[0] : null;
    await this.db().order.update({
      where: { id: order.id },
      data: {
        deliveryType: "PLATFORM",
        courierProvider: "STUART",
        courierJobId: String(job?.id ?? delivery?.id ?? ""),
        // This order's leg. The webhook resolves by it first, so single and
        // multi-drop jobs route through the same path.
        courierDeliveryId: delivery?.id != null ? String(delivery.id) : null,
        courierStatus: job?.status ?? delivery?.status ?? "new",
        courierTrackingUrl: delivery?.tracking_url ?? null,
      },
    });

    this.logger.log(
      `Stuart dispatch OK order=${order.id} job=${job?.id} fee=${args.isAdmin ? "0 (admin bypass)" : `${feeMinor}p`}`,
    );

    return {
      ok: true,
      jobId: job?.id ?? null,
      status: job?.status ?? delivery?.status ?? "new",
      trackingUrl: delivery?.tracking_url ?? null,
      feeChargedMinor: args.isAdmin ? 0 : feeMinor,
      adminBypass: args.isAdmin,
    };
  }

  async cancel(args: { orderId: string; tenantId: string }) {
    const order = await this.db().order.findFirst({
      where: { id: args.orderId, tenantId: args.tenantId },
    });
    if (!order) throw new NotFoundException("Order not found");
    if (order.courierProvider !== "STUART" || !order.courierJobId) {
      throw new BadRequestException("This order isn't on a Stuart courier.");
    }
    const cfg = await this.config.getDecrypted(order.locationId);
    if (cfg) {
      // On a multi-drop run other orders share this job, and cancelling the
      // JOB would take every one of them off the courier. So when anyone else
      // is still on it, cancel only this order's leg. The last order left on a
      // job (or a job from before per-leg ids existed) cancels the job as it
      // always has.
      const othersOnJob = order.courierDeliveryId
        ? await this.db().order.count({
            where: {
              courierProvider: "STUART",
              courierJobId: order.courierJobId,
              id: { not: order.id },
            },
          })
        : 0;
      // Never let a Stuart-side failure (e.g. the job already delivered or
      // cancelled) block clearing our record — otherwise the operator can
      // neither track nor re-dispatch the order.
      try {
        if (othersOnJob > 0) {
          await this.client.cancelDelivery(cfg, order.courierDeliveryId);
        } else {
          await this.client.cancelJob(cfg, order.courierJobId);
        }
      } catch (err: any) {
        this.logger.warn(
          `Stuart cancel for job ${order.courierJobId}${othersOnJob > 0 ? ` leg ${order.courierDeliveryId}` : ""} failed (clearing locally anyway): ${err?.message ?? err}`,
        );
      }
    }
    // Clear the courier attachment + drop the order back to READY so it can be
    // dispatched again (to Stuart, own fleet, or anything else).
    await this.db().order.update({
      where: { id: order.id },
      data: {
        courierProvider: null,
        courierJobId: null,
        courierDeliveryId: null,
        courierName: null,
        courierPhone: null,
        courierPhoneAccessCode: null,
        courierTrackingUrl: null,
        courierStatus: null,
        courierAssignedAt: null,
        courierPickedUpAt: null,
        courierDeliveredAt: null,
        deliveryType: null,
        status: "READY",
      },
    });
    // Dispatch fee is non-refundable on operator cancel — the job was created.
    return { ok: true };
  }

  // ── Bulk: several orders on one Stuart courier ─────────────────────────────

  private orderRef(order: any): string {
    return String(
      order.displayId ??
        (order.orderNumber != null ? `#${order.orderNumber}` : order.id),
    );
  }

  /**
   * Load and validate a run before anything is quoted or charged.
   *
   * Every refusal names the order it is about, because the operator picked
   * several and "one of them is wrong" leaves them guessing which. All checks
   * run before any write, so a bad pick never leaves half a run dispatched.
   */
  private async loadBulk(orderIds: string[], user: AuthenticatedUser) {
    const ids = [...new Set((orderIds ?? []).filter(Boolean))];
    if (ids.length === 0) {
      throw new BadRequestException("Select at least one order to dispatch.");
    }
    if (ids.length > STUART_MAX_DROPOFFS) {
      throw new BadRequestException(
        `Stuart takes up to ${STUART_MAX_DROPOFFS} orders on one courier — you selected ${ids.length}.`,
      );
    }

    const found = await this.db().order.findMany({
      where: { id: { in: ids }, tenantId: user.tenantId },
    });
    if (found.length !== ids.length) {
      throw new NotFoundException(
        "One or more of those orders no longer exists. Refresh the board and try again.",
      );
    }

    // One courier collects from one shop.
    const locationIds = new Set(found.map((o: any) => o.locationId));
    const locationId = found[0].locationId as string | null;
    if (locationIds.size !== 1 || !locationId) {
      throw new BadRequestException(
        "A Stuart run collects from one shop. Pick orders from the same location.",
      );
    }

    // The tenant match above is not enough: a manager must only dispatch
    // orders from shops they can see on the board.
    const scope = await resolveOrderScope(this.prisma, user);
    if (!scope.admin && !scope.allowedLocationIds.includes(locationId)) {
      throw new ForbiddenException(
        "Those orders aren't in one of your locations.",
      );
    }

    for (const o of found) {
      const ref = this.orderRef(o);
      // A marketplace order the SHOP delivers (MERCHANT_DELIVERY) is a
      // delivery a courier can carry; only PICKUP and DINE_IN are not. The
      // marketplace's own riders are excluded by deliveryType below.
      if (!DISPATCHABLE_FULFILLMENTS.includes(o.fulfillmentType)) {
        throw new BadRequestException(`${ref} isn't a delivery.`);
      }
      if (o.courierJobId) {
        throw new BadRequestException(`${ref} is already on a courier.`);
      }
      if (o.deliveryType === "PLATFORM") {
        throw new BadRequestException(
          `${ref} is delivered by the marketplace's own rider.`,
        );
      }
      if (!BULK_DISPATCHABLE.has(o.status)) {
        throw new BadRequestException(
          `${ref} is ${String(o.status).toLowerCase().replace(/_/g, " ")} — only accepted, preparing or ready orders can go on a courier.`,
        );
      }
      if (!this.addressString(o.deliveryAddress as Record<string, any> | null)) {
        throw new BadRequestException(`${ref} has no delivery address.`);
      }
    }

    const location = await this.db().location.findUnique({
      where: { id: locationId },
    });
    if (!location) {
      throw new BadRequestException("Those orders have no shop to collect from.");
    }
    const cfg = await this.config.getDecrypted(locationId);
    if (!cfg) {
      throw new BadRequestException(
        "Stuart isn't set up for this location. Add the client ID/secret in Location settings.",
      );
    }
    if (!cfg.active) {
      throw new BadRequestException(
        "Stuart dispatch is switched off for this location. Turn it on in Location settings.",
      );
    }

    // Keep the operator's pick order. Stuart reorders the route itself, but
    // this is the order they'll read the run back in.
    const byId = new Map<string, any>(found.map((o: any) => [o.id as string, o]));
    const orders: any[] = ids.map((id) => byId.get(id));
    return { orders, location, cfg };
  }

  /**
   * One pickup, one dropoff per order.
   *
   * client_reference is the only thing that ties a returned delivery back to
   * its order — Stuart reorders the dropoffs, so position in the response
   * means nothing. It must be unique, and a re-dispatch after a cancel must not
   * collide with the last attempt, so it carries a per-attempt token. It
   * starts with the order ref so it still reads as the order to a human.
   */
  private buildBulkPayload(orders: any[], location: any) {
    const pickupAddress = this.addressString(null, [
      location.addressLine1,
      location.addressLine2,
      location.city,
      location.postcode,
    ]);
    if (!pickupAddress) {
      throw new BadRequestException(
        "This location has no address set — add it in Location settings before dispatching.",
      );
    }
    const attempt = Date.now().toString(36);
    const orderIdByReference = new Map<string, string>();
    const refs = orders.map((o) => this.orderRef(o));

    const payload: StuartJobPayload = {
      job: {
        pickups: [
          {
            address: pickupAddress,
            comment: `${orders.length} orders: ${refs.join(", ")}`,
            contact: {
              firstname: location.name ?? "Restaurant",
              lastname: "",
              phone: location.phone ?? undefined,
              company: location.name ?? undefined,
            },
          },
        ],
        dropoffs: orders.map((o, i) => {
          const reference = `${refs[i]}-${attempt}-${i + 1}`;
          orderIdByReference.set(reference, o.id);
          const cust = this.splitName(o.customerName);
          return {
            package_type: "medium",
            package_description: `Order ${refs[i]}`,
            client_reference: reference,
            address: this.addressString(
              o.deliveryAddress as Record<string, any> | null,
            ),
            contact: {
              firstname: cust.firstname,
              lastname: cust.lastname,
              phone: o.customerPhone ?? undefined,
            },
          };
        }),
      },
    };
    return { payload, orderIdByReference };
  }

  /** Price the whole run — Stuart quotes one amount for the job. No charge. */
  async quoteBulk(args: { orderIds: string[]; user: AuthenticatedUser }) {
    const { orders, location, cfg } = await this.loadBulk(args.orderIds, args.user);
    const { payload } = this.buildBulkPayload(orders, location);
    const pricing = await this.client.pricing(cfg, payload);
    const feeEachMinor = this.wallet.dispatchFeeMinor();
    return {
      currency: pricing?.currency ?? "GBP",
      amount: pricing?.amount ?? pricing?.price_tax_included ?? null,
      orders: orders.length,
      dispatchFeeEachMinor: feeEachMinor,
      dispatchFeeMinor: feeEachMinor * orders.length,
    };
  }

  /**
   * Dispatch several orders to ONE Stuart courier.
   *
   * Money follows the single-order rule, once per order: the flat fee is
   * charged per order dispatched (the wallet ledger is keyed by order, and a
   * cancelled leg keeps its own fee exactly as a cancelled single dispatch
   * does). The whole run's fees are checked up front so a short wallet refuses
   * before anything moves, then each order is debited; if the job then fails
   * to create, every fee taken is refunded.
   */
  async dispatchBulk(args: {
    orderIds: string[];
    user: AuthenticatedUser;
    isAdmin: boolean;
  }) {
    const { orders, location, cfg } = await this.loadBulk(args.orderIds, args.user);
    const { payload, orderIdByReference } = this.buildBulkPayload(orders, location);
    const feeMinor = this.wallet.dispatchFeeMinor();
    const tenantId = args.user.tenantId;
    const locationId = location.id as string;
    const createdBy = args.user.userId ?? null;

    const charged: string[] = [];
    const refundAll = async () => {
      for (const orderId of charged) {
        await this.wallet.refundDispatch({
          tenantId,
          locationId,
          orderId,
          amountMinor: feeMinor,
          createdBy,
        });
      }
    };

    if (!args.isAdmin) {
      await this.wallet.assertCanAffordDispatch(
        tenantId,
        locationId,
        feeMinor * orders.length,
      );
      try {
        for (const o of orders) {
          await this.wallet.debitForDispatch({
            tenantId,
            locationId,
            orderId: o.id,
            amountMinor: feeMinor,
            createdBy,
          });
          charged.push(o.id);
        }
      } catch (err) {
        // Another dispatch drained the wallet between the check and here.
        await refundAll();
        throw err;
      }
    }

    let job: any;
    try {
      job = await this.client.createJob(cfg, payload);
    } catch (err: any) {
      await refundAll();
      this.logger.error(
        `Stuart run failed for orders ${orders.map((o) => o.id).join(",")}: ${err?.message ?? err}`,
      );
      throw new BadRequestException(
        `Stuart couldn't create the run: ${err?.message ?? "unknown error"}`,
      );
    }

    const jobId = String(job?.id ?? "");
    const deliveries: any[] = Array.isArray(job?.deliveries) ? job.deliveries : [];
    const results: Array<{
      orderId: string;
      deliveryId: string | null;
      trackingUrl: string | null;
    }> = [];

    for (const o of orders) {
      const leg = deliveries.find(
        (d) => orderIdByReference.get(String(d?.client_reference ?? "")) === o.id,
      );
      if (!leg) {
        // The courier is booked either way, so the order is still marked as
        // on this job (it must not be dispatched twice) — but without its leg
        // id its tracking won't update, and that needs to be seen.
        this.logger.error(
          `Stuart run ${jobId}: no delivery came back for order ${o.id} — its tracking will not update`,
        );
      }
      await this.db().order.update({
        where: { id: o.id },
        data: {
          deliveryType: "PLATFORM",
          courierProvider: "STUART",
          courierJobId: jobId,
          courierDeliveryId: leg?.id != null ? String(leg.id) : null,
          courierStatus: leg?.status ?? job?.status ?? "new",
          courierTrackingUrl: leg?.tracking_url ?? null,
        },
      });
      results.push({
        orderId: o.id,
        deliveryId: leg?.id != null ? String(leg.id) : null,
        trackingUrl: leg?.tracking_url ?? null,
      });
    }

    this.logger.log(
      `Stuart run OK job=${jobId} orders=${orders.length} fee=${args.isAdmin ? "0 (admin bypass)" : `${feeMinor}p each`}`,
    );

    return {
      ok: true,
      jobId,
      orders: results,
      feeChargedMinor: args.isAdmin ? 0 : feeMinor * orders.length,
      adminBypass: args.isAdmin,
    };
  }
}
