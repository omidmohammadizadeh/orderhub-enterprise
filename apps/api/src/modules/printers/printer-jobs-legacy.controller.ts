// ─────────────────────────────────────────────────────────────────────────────
// Legacy printer-jobs API — Base44 / Flutter Android printer-app compatibility
//
// The old Flutter print agent polls a fixed contract:
//
//   GET   /api/v1/printer-jobs?shop_code={code}&limit=20
//   PATCH /api/v1/printer-jobs/{id}    body: { status, error? }
//   header X-Print-Token: <token>
//
// Status vocabulary in the Flutter app is the lowercase quadruplet
//   pending | printing | printed | failed
// which maps onto our PrintJobStatus enum:
//   QUEUED / PRINTING / PRINTED / FAILED   (RETRYING is internal-only)
//
// Payload shape returned by GET must match the Base44 structure so the
// agent's receipt formatter doesn't have to change. We rebuild it from
// canonical data on each fetch rather than trusting whatever the worker
// happened to stash in PrintJob.payload — that field's schema has drifted
// over time and the agent expects the documented shape verbatim.
//
// SECURITY MODEL — token enforcement
//   - Each Location has an optional printToken (UNIQUE).
//   - If the location has a token set, X-Print-Token MUST match.
//   - If the location has no token yet, the endpoint accepts the request
//     and logs a warning so operators can see they need to provision one.
//     This avoids breaking existing customers the moment we ship the
//     new endpoint; they get a grace period to set a token.
//
// The controller is mounted at `printer-jobs` and the methods are marked
// @Public() because the Flutter agent does not present a JWT — the
// X-Print-Token header is the auth.
// ─────────────────────────────────────────────────────────────────────────────

import {
  Controller,
  Get,
  Patch,
  Param,
  Query,
  Body,
  Headers,
  HttpCode,
  HttpStatus,
  NotFoundException,
  UnauthorizedException,
  Logger,
} from "@nestjs/common";
import { ApiTags, ApiOperation } from "@nestjs/swagger";
import { Public } from "../../common/decorators/public.decorator";
import { BillingExempt } from "../../common/guards/billing.guard";
import { PrismaService } from "../../infrastructure/database/prisma.service";

interface Base44Receipt {
  order_number: string | null;
  created_at: string;
  order_type: string | null;
  order_source: string | null;
  channel: string | null;
  collection_code: string | null;
  scheduled_time: string | null;
  customer: { name: string | null; phone: string | null; address: string | null };
  items: Array<{
    name: string;
    qty: number;
    price: number;
    notes: string | null;
    modifiers: unknown;
  }>;
  notes: string | null;
  totals: {
    subtotal: number;
    discount: number;
    discount_codes: string[];
    delivery_fee: number;
    total: number;
  };
  payment: { type: string | null; status: string | null };
  promo_banner: string | null;
}

@ApiTags("printer-jobs (legacy)")
@Controller({ path: "printer-jobs", version: "1" })
export class PrinterJobsLegacyController {
  private readonly logger = new Logger(PrinterJobsLegacyController.name);

  constructor(private readonly prisma: PrismaService) {}

  // ── GET /api/v1/printer-jobs ──────────────────────────────────────────────
  @Get()
  @Public()
  @BillingExempt()
  @ApiOperation({
    summary:
      "Flutter printer agent: poll pending print jobs for a location (Base44 shape)",
  })
  async list(
    @Query("shop_code") shopCode: string,
    @Query("limit") limitRaw?: string,
    @Query("status") statusFilter?: string,
    @Headers("x-print-token") token?: string,
  ) {
    if (!shopCode) return [];

    const location = await this.prisma.location.findFirst({
      where: {
        OR: [{ shopCode: shopCode }, { id: shopCode }],
      },
      select: { id: true, printToken: true, name: true },
    });
    if (!location) return [];

    this.assertToken(location, token);

    const limit = Math.min(parseInt(limitRaw ?? "20", 10) || 20, 100);

    const jobs = await this.prisma.printJob.findMany({
      where: {
        locationId: location.id,
        status: this.parseStatusFilter(statusFilter) ?? "QUEUED",
      },
      include: {
        order: {
          include: { items: true, location: { select: { name: true } } },
        },
      },
      orderBy: { createdAt: "asc" },
      take: limit,
    });

    return jobs.map((job) => ({
      id: job.id,
      type: job.type,
      status: this.toLegacyStatus(job.status),
      created_at: job.createdAt.toISOString(),
      order_id: job.orderId,
      printer_id: job.printerId,
      payload: job.order ? this.buildBase44Payload(job, job.order) : job.payload,
    }));
  }

  // ── PATCH /api/v1/printer-jobs/:id ────────────────────────────────────────
  @Patch(":id")
  @Public()
  @BillingExempt()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      "Flutter printer agent: update job status (pending → printing → printed/failed)",
  })
  async update(
    @Param("id") jobId: string,
    @Body() body: { status: string; error?: string },
    @Headers("x-print-token") token?: string,
  ) {
    const job = await this.prisma.printJob.findUnique({
      where: { id: jobId },
      select: { id: true, locationId: true, status: true },
    });
    if (!job) throw new NotFoundException("Print job not found");

    const location = await this.prisma.location.findUnique({
      where: { id: job.locationId },
      select: { id: true, printToken: true, name: true },
    });
    if (location) this.assertToken(location, token);

    const newStatus = this.fromLegacyStatus(body.status);
    if (!newStatus) {
      throw new NotFoundException(
        `Unknown status '${body.status}' — expected pending|printing|printed|failed`,
      );
    }

    await this.prisma.printJob.update({
      where: { id: jobId },
      data: {
        status: newStatus,
        printedAt: newStatus === "PRINTED" ? new Date() : undefined,
        error: body.error ?? null,
        attempts: { increment: 1 },
      },
    });

    return { id: jobId, status: this.toLegacyStatus(newStatus) };
  }

  // ── helpers ───────────────────────────────────────────────────────────────

  private assertToken(
    location: { id: string; printToken: string | null; name: string | null },
    token?: string,
  ): void {
    // Grace mode: location hasn't provisioned a token yet. We allow the
    // request but loudly log so operators can see they need to set one.
    if (!location.printToken) {
      this.logger.warn(
        `Printer agent polled location ${location.id} (${location.name ?? "?"}) without a printToken set — set one to enforce auth.`,
      );
      return;
    }
    if (!token || token !== location.printToken) {
      throw new UnauthorizedException("Invalid or missing X-Print-Token");
    }
  }

  private parseStatusFilter(
    raw?: string,
  ): "QUEUED" | "PRINTING" | "PRINTED" | "FAILED" | undefined {
    if (!raw || raw === "all") return undefined;
    return this.fromLegacyStatus(raw) ?? "QUEUED";
  }

  private fromLegacyStatus(
    raw: string,
  ): "QUEUED" | "PRINTING" | "PRINTED" | "FAILED" | null {
    switch (raw.toLowerCase()) {
      case "pending":
      case "queued":
        return "QUEUED";
      case "printing":
        return "PRINTING";
      case "printed":
        return "PRINTED";
      case "failed":
        return "FAILED";
      default:
        return null;
    }
  }

  private toLegacyStatus(s: string): string {
    switch (s) {
      case "QUEUED":
        return "pending";
      case "PRINTING":
        return "printing";
      case "PRINTED":
        return "printed";
      case "FAILED":
        return "failed";
      default:
        return s.toLowerCase();
    }
  }

  // Build the Base44 receipt payload from the canonical order. Keeping
  // this here (rather than trusting whatever the worker wrote into
  // PrintJob.payload) means we can evolve the worker without breaking
  // the Flutter agent contract.
  private buildBase44Payload(
    job: { id: string; type: string; createdAt: Date },
    order: any,
  ): Base44Receipt {
    const customerInfo = (order.customerInfo ?? {}) as Record<string, any>;
    const deliveryAddress = order.deliveryAddress as Record<string, any> | null;

    const addressStr = deliveryAddress
      ? [deliveryAddress.line1, deliveryAddress.line2, deliveryAddress.city, deliveryAddress.postcode]
          .filter(Boolean)
          .join(", ")
      : null;

    return {
      order_number: order.displayId ?? order.externalId ?? order.id,
      created_at: order.createdAt.toISOString(),
      order_type: order.fulfillmentType ?? null,
      order_source: order.orderSource ?? null,
      channel: order.platform ?? null,
      collection_code: order.collectionCode ?? null,
      scheduled_time: order.scheduledFor?.toISOString() ?? null,
      customer: {
        name: customerInfo.name ?? order.customerName ?? null,
        phone: customerInfo.phone ?? order.customerPhone ?? null,
        address: addressStr,
      },
      items: (order.items ?? []).map((i: any) => ({
        name: i.name,
        qty: i.quantity,
        price: Number(i.totalPrice),
        notes: i.notes ?? null,
        modifiers: i.modifiers ?? [],
      })),
      notes: order.specialInstructions ?? null,
      totals: {
        subtotal: Number(order.subtotal),
        discount: Number(order.discount),
        discount_codes: order.promoCode ? [order.promoCode] : [],
        delivery_fee: Number(order.deliveryFee),
        total: Number(order.total),
      },
      payment: {
        type: order.paymentMethod ?? null,
        status: order.paymentStatus ?? null,
      },
      promo_banner: null,
    };
  }
}
