// Phase BI — dispatch an order to an Uber Direct courier.
//
// Same money rule as Stuart: debit the location wallet a flat fee BEFORE we
// create the delivery, refund if creation fails, PLATFORM_ADMIN bypasses. Uber
// bills the restaurant's own Direct account for the courier.

import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from "@nestjs/common";
import { PrismaService } from "../../../infrastructure/database/prisma.service";
import { WalletService } from "../../wallet/wallet.service";
import { UberDirectConfigService } from "./uber-direct-config.service";
import {
  UberDirectClientService,
  UberDirectDeliveryBody,
  UberDirectQuoteBody,
} from "./uber-direct-client.service";

interface DispatchArgs {
  orderId: string;
  tenantId: string;
  userId?: string | null;
  isAdmin: boolean;
}

@Injectable()
export class UberDirectDispatchService {
  private readonly logger = new Logger(UberDirectDispatchService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly wallet: WalletService,
    private readonly config: UberDirectConfigService,
    private readonly client: UberDirectClientService,
  ) {}

  private db(): any {
    return this.prisma as any;
  }

  /** Uber Direct wants the address as a JSON-encoded structured object. */
  private addressJson(parts: {
    line1?: string | null;
    line2?: string | null;
    city?: string | null;
    postcode?: string | null;
  }): string | null {
    const street = [parts.line1, parts.line2]
      .map((p) => (typeof p === "string" ? p.trim() : ""))
      .filter(Boolean);
    if (!street.length && !parts.postcode) return null;
    return JSON.stringify({
      street_address: street.length ? street : [parts.postcode ?? ""],
      city: (parts.city ?? "").trim(),
      state: "",
      zip_code: (parts.postcode ?? "").trim(),
      country: "GB",
    });
  }

  private buildQuoteBody(order: any, location: any): UberDirectQuoteBody {
    const pickup = this.addressJson({
      line1: location.addressLine1,
      line2: location.addressLine2,
      city: location.city,
      postcode: location.postcode,
    });
    const da = (order.deliveryAddress as Record<string, any>) ?? {};
    const dropoff = this.addressJson({
      line1: da.line1 ?? da.addressLine1 ?? da.address_1,
      line2: da.line2 ?? da.addressLine2 ?? da.address_2,
      city: da.city ?? da.town,
      postcode: da.postcode ?? da.postal_code ?? da.zip,
    });
    if (!pickup) {
      throw new BadRequestException(
        "This location has no address set — add it in Location settings before dispatching.",
      );
    }
    if (!dropoff) {
      throw new BadRequestException(
        "This order has no delivery address to dispatch to.",
      );
    }
    return {
      pickup_address: pickup,
      dropoff_address: dropoff,
      pickup_phone_number: location.phone ?? undefined,
      dropoff_phone_number: order.customerPhone ?? undefined,
    };
  }

  private buildDeliveryBody(
    order: any,
    location: any,
    quoteId?: string,
  ): UberDirectDeliveryBody {
    const q = this.buildQuoteBody(order, location);
    const items = Array.isArray(order.items) ? order.items : [];
    const manifest = items.length
      ? items.map((it: any) => ({
          name: it.name ?? "Item",
          quantity: Number(it.quantity ?? 1),
          size: "small",
        }))
      : [{ name: "Order", quantity: 1, size: "small" }];
    return {
      ...(quoteId ? { quote_id: quoteId } : {}),
      pickup_name: location.name ?? "Restaurant",
      pickup_address: q.pickup_address,
      pickup_phone_number: location.phone ?? "+440000000000",
      pickup_business_name: location.name ?? undefined,
      dropoff_name: order.customerName ?? "Customer",
      dropoff_address: q.dropoff_address,
      dropoff_phone_number: order.customerPhone ?? "+440000000000",
      dropoff_notes: order.deliveryInstructions ?? undefined,
      manifest_items: manifest,
      external_id: String(order.displayId ?? order.orderNumber ?? order.id),
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
        "Uber Direct isn't set up for this location. Add the credentials in Location settings.",
      );
    }
    if (!cfg.active) {
      throw new BadRequestException(
        "Uber Direct is switched off for this location. Turn it on in Location settings.",
      );
    }
    return { order, location, cfg };
  }

  async quote(args: { orderId: string; tenantId: string }) {
    const { order, location, cfg } = await this.load(args.orderId, args.tenantId);
    const q = await this.client.quote(cfg, this.buildQuoteBody(order, location));
    // Uber Direct returns `fee` in minor units (pence).
    const feeMinor = typeof q?.fee === "number" ? q.fee : null;
    return {
      currency: q?.currency ?? "GBP",
      amount: feeMinor != null ? feeMinor / 100 : null,
      quoteId: q?.id ?? null,
      dispatchFeeMinor: this.wallet.dispatchFeeMinor(),
      raw: q,
    };
  }

  async dispatch(args: DispatchArgs) {
    const { order, location, cfg } = await this.load(args.orderId, args.tenantId);
    if (order.courierProvider === "UBER_DIRECT" && order.courierJobId) {
      throw new BadRequestException(
        "This order was already dispatched to Uber Direct.",
      );
    }

    // Best-effort quote first (attaches quote_id + gives us a price to log).
    let quoteId: string | undefined;
    try {
      const q = await this.client.quote(cfg, this.buildQuoteBody(order, location));
      quoteId = q?.id ?? undefined;
    } catch (err: any) {
      this.logger.warn(
        `Uber Direct quote failed for order ${order.id} (creating without quote_id): ${err?.message ?? err}`,
      );
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

    let delivery: any;
    try {
      delivery = await this.client.createDelivery(
        cfg,
        this.buildDeliveryBody(order, location, quoteId),
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
      this.logger.error(
        `Uber Direct dispatch failed for order ${order.id}: ${err?.message ?? err}`,
      );
      throw new BadRequestException(
        `Uber Direct couldn't create the delivery: ${err?.message ?? "unknown error"}`,
      );
    }

    await this.db().order.update({
      where: { id: order.id },
      data: {
        deliveryType: "PLATFORM",
        courierProvider: "UBER_DIRECT",
        courierJobId: String(delivery?.id ?? ""),
        courierStatus: delivery?.status ?? "pending",
        courierTrackingUrl: delivery?.tracking_url ?? null,
      },
    });

    this.logger.log(
      `Uber Direct dispatch OK order=${order.id} delivery=${delivery?.id} fee=${args.isAdmin ? "0 (admin bypass)" : `${feeMinor}p`}`,
    );

    return {
      ok: true,
      jobId: delivery?.id ?? null,
      status: delivery?.status ?? "pending",
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
    if (order.courierProvider !== "UBER_DIRECT" || !order.courierJobId) {
      throw new BadRequestException("This order isn't on an Uber Direct courier.");
    }
    const cfg = await this.config.getDecrypted(order.locationId);
    if (cfg) {
      try {
        await this.client.cancelDelivery(cfg, order.courierJobId);
      } catch (err: any) {
        this.logger.warn(
          `Uber Direct cancel for ${order.courierJobId} failed (clearing locally anyway): ${err?.message ?? err}`,
        );
      }
    }
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
    return { ok: true };
  }
}
