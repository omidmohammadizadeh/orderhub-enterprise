// Phase BH — dispatch an order to a Stuart courier.
//
// Money rule: OrderHub charges the location wallet a flat fee (default 50p) per
// dispatch. The wallet is debited BEFORE we create the Stuart job and refunded
// if job creation fails, so we never dispatch for free and never charge for a
// failed dispatch. PLATFORM_ADMIN bypasses the wallet entirely (test flow).
// Stuart bills the restaurant's own account for the actual courier cost.

import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from "@nestjs/common";
import { PrismaService } from "../../../infrastructure/database/prisma.service";
import { WalletService } from "../../wallet/wallet.service";
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
      // Cancel the job at Stuart, but never let a Stuart-side failure (e.g. the
      // job already delivered/cancelled) block clearing our record — otherwise
      // the operator can neither track nor re-dispatch the order.
      try {
        await this.client.cancelJob(cfg, order.courierJobId);
      } catch (err: any) {
        this.logger.warn(
          `Stuart cancel for job ${order.courierJobId} failed (clearing locally anyway): ${err?.message ?? err}`,
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
}
