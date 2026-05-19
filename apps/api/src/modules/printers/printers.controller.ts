import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
  Query,
  HttpCode,
  HttpStatus,
  ParseUUIDPipe,
  NotFoundException,
} from "@nestjs/common";
import { ApiTags, ApiOperation, ApiBearerAuth } from "@nestjs/swagger";
import { Public } from "../../common/decorators/public.decorator";
import { BillingExempt } from "../../common/guards/billing.guard";
import { PrintersService } from "./printers.service";
import { PrintQueueService } from "./print-queue.service";
import { CurrentUser } from "../../common/decorators/current-user.decorator";
import { Roles } from "../../common/decorators/roles.decorator";
import { PrismaService } from "../../infrastructure/database/prisma.service";
import type { AuthenticatedUser } from "../auth/interfaces/jwt-payload.interface";

@ApiTags("printers")
@ApiBearerAuth()
@Controller({ path: "printers", version: "1" })
export class PrintersController {
  constructor(
    private readonly printers: PrintersService,
    private readonly printQueue: PrintQueueService,
    private readonly prisma: PrismaService,
  ) {}

  @Get()
  @BillingExempt() // Read-only: UNPAID tenants need to see printer state for support/emergency
  @ApiOperation({ summary: "List printers for a location" })
  findAll(
    @CurrentUser() user: AuthenticatedUser,
    @Query("locationId") locationId: string,
  ) {
    return this.printers.findByLocation(locationId, user.tenantId);
  }

  // Registering a new printer is a commercial action — blocked for UNPAID/CANCELLED tenants.
  // Existing printers continue to work (all other endpoints are billing-exempt).
  @Post()
  @Roles("MANAGER", "TENANT_OWNER", "PLATFORM_ADMIN")
  @ApiOperation({ summary: "Register a printer" })
  create(
    @CurrentUser() user: AuthenticatedUser,
    @Query("locationId") locationId: string,
    @Body() body: any,
  ) {
    return this.printers.create(locationId, user.tenantId, body);
  }

  @Patch(":id")
  @BillingExempt() // Updating existing printer config is live ops — never blocked
  @Roles("MANAGER", "TENANT_OWNER", "PLATFORM_ADMIN")
  @ApiOperation({ summary: "Update printer configuration" })
  update(
    @Param("id", ParseUUIDPipe) id: string,
    @Body() body: any,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.printers.update(id, user.tenantId, body);
  }

  @Delete(":id")
  @BillingExempt() // Deregistering a printer is live ops — never blocked
  @Roles("MANAGER", "TENANT_OWNER", "PLATFORM_ADMIN")
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: "Remove a printer" })
  remove(
    @Param("id", ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.printers.delete(id, user.tenantId);
  }

  @Get(":id/jobs")
  @BillingExempt() // Job history is live ops view — never blocked
  @ApiOperation({ summary: "Get recent print jobs for a printer" })
  getJobs(
    @Param("id", ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.printers.getJobs(id, user.tenantId);
  }

  @Post(":id/jobs/:jobId/reprint")
  @BillingExempt() // Reprinting a live order receipt is critical — never blocked
  @Roles("CASHIER", "MANAGER", "TENANT_OWNER", "PLATFORM_ADMIN")
  @ApiOperation({ summary: "Reprint a job" })
  reprint(@Param("jobId") jobId: string) {
    return this.printQueue.reprint(jobId);
  }

  // Retry endpoint used by the printer diagnostics frontend page
  @Post(":id/jobs/:jobId/retry")
  @BillingExempt() // Retrying a failed live job is critical — never blocked
  @Roles("CASHIER", "MANAGER", "TENANT_OWNER", "PLATFORM_ADMIN")
  @ApiOperation({ summary: "Retry a failed print job" })
  retry(@Param("jobId") jobId: string) {
    return this.printQueue.reprint(jobId);
  }

  // Test print — triggers a minimal receipt to confirm printer connectivity
  @Post(":id/test")
  @BillingExempt() // Diagnostic test print is a live ops tool — never blocked
  @Roles("MANAGER", "TENANT_OWNER", "PLATFORM_ADMIN")
  @ApiOperation({ summary: "Send a test print to a printer" })
  async testPrint(
    @Param("id", ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    const printer = await this.prisma.printer.findFirst({
      where: { id, location: { brand: { tenantId: user.tenantId } } },
    });
    if (!printer) throw new NotFoundException("Printer not found");

    // Create a synthetic test job
    const job = await this.prisma.printJob.create({
      data: {
        tenantId: user.tenantId,
        locationId: printer.locationId,
        printerId: id,
        type: "RECEIPT",
        status: "QUEUED",
        payload: {
          type: "RECEIPT",
          orderId: null,
          displayId: "TEST",
          platform: "DIRECT",
          orderSource: "DIRECT",
          fulfillmentType: "COLLECTION",
          customerName: "Test Print",
          items: [{ name: "Test Item", quantity: 1, unitPrice: 100, totalPrice: 100, modifiers: [] }],
          subtotal: 100,
          taxAmount: 20,
          deliveryFee: 0,
          discount: 0,
          total: 120,
          specialInstructions: "This is a test print from OrderHub diagnostics",
          printedAt: new Date().toISOString(),
        },
      },
    });

    return this.printQueue.enqueueRawJob(job.id, user.tenantId, printer.locationId, id);
  }

  // ── Flutter Android printer app compatibility endpoints ─────────────────────
  // The Flutter app polls GET /api/v1/printerJobs?shop_code=:locationCode
  // to retrieve pending print jobs, then PATCHes the status to "printed".
  // This is the existing contract that must not be broken.

  @Get("/jobs")
  @Public()
  @BillingExempt() // Flutter polling is the live printer contract — must never be blocked
  @ApiOperation({ summary: "Flutter app: poll pending print jobs by location code" })
  async getPrintJobsForFlutter(
    @Query("shop_code") shopCode: string,
    @Query("status") status?: string,
  ) {
    if (!shopCode) return [];

    // shop_code maps to location.shopCode (or fall back to location.id for legacy)
    const location = await (this.prisma as any).location.findFirst({
      where: {
        OR: [
          { shopCode: shopCode },
          { id: shopCode },
        ],
      },
      select: { id: true },
    });

    if (!location) return [];

    const jobs = await this.prisma.printJob.findMany({
      where: {
        locationId: location.id,
        status: status === "all" ? undefined : "QUEUED",
      },
      include: { order: { include: { items: true } } },
      orderBy: { createdAt: "asc" },
      take: 50,
    });

    // Return Flutter-compatible payload
    return jobs.map((job) => ({
      id: job.id,
      type: job.type,
      status: job.status,
      payload: job.payload,
      orderId: job.orderId,
      printerId: job.printerId,
      createdAt: job.createdAt.toISOString(),
    }));
  }

  @Patch("/jobs/:jobId")
  @Public()
  @BillingExempt() // Flutter status update is the live printer contract — must never be blocked
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Flutter app: update print job status (e.g. mark as printed)" })
  async updatePrintJobStatus(
    @Param("jobId") jobId: string,
    @Body() body: { status: string; error?: string },
  ) {
    const job = await this.prisma.printJob.findUnique({ where: { id: jobId } });
    if (!job) throw new NotFoundException("Print job not found");

    const newStatus = body.status === "printed" ? "PRINTED" : body.status.toUpperCase();

    await this.prisma.printJob.update({
      where: { id: jobId },
      data: {
        status: newStatus as any,
        printedAt: newStatus === "PRINTED" ? new Date() : undefined,
        error: body.error ?? null,
        attempts: { increment: 1 },
      },
    });

    return { id: jobId, status: newStatus };
  }
}
