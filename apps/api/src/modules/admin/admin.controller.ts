import {
  Controller,
  Get,
  Post,
  Delete,
  Param,
  Query,
  ParseIntPipe,
  DefaultValuePipe,
  HttpCode,
  HttpStatus,
} from "@nestjs/common";
import { ApiTags, ApiOperation, ApiBearerAuth, ApiQuery } from "@nestjs/swagger";
import { Throttle } from "@nestjs/throttler";
import { AdminService } from "./admin.service";
import { Roles } from "../../common/decorators/roles.decorator";
import { CurrentTenantId } from "../../common/decorators/current-tenant.decorator";

@ApiTags("Admin")
@ApiBearerAuth()
@Roles("PLATFORM_ADMIN", "TENANT_OWNER")
@Controller({ path: "admin", version: "1" })
@Throttle({ short: { limit: 5, ttl: 1000 }, medium: { limit: 60, ttl: 60000 } })
export class AdminController {
  constructor(private readonly admin: AdminService) {}

  // ── Queue Stats ────────────────────────────────────────

  @Get("queues")
  @ApiOperation({ summary: "Get queue statistics for all managed queues" })
  getQueueStats() {
    return this.admin.getQueueStats();
  }

  @Get("queues/:queue/failed")
  @ApiOperation({ summary: "List failed jobs in a queue (DLQ inspector)" })
  @ApiQuery({ name: "limit", required: false, type: Number })
  getFailedJobs(
    @Param("queue") queue: string,
    @Query("limit", new DefaultValuePipe(50), ParseIntPipe) limit: number,
  ) {
    return this.admin.getFailedJobs(queue, limit);
  }

  @Get("queues/:queue/active")
  @ApiOperation({ summary: "List currently active (in-flight) jobs in a queue" })
  getActiveJobs(@Param("queue") queue: string) {
    return this.admin.getActiveJobs(queue);
  }

  @Post("queues/:queue/failed/:jobId/retry")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Retry a single failed job by ID" })
  retryJob(@Param("queue") queue: string, @Param("jobId") jobId: string) {
    return this.admin.retryFailedJob(queue, jobId);
  }

  @Post("queues/:queue/failed/retry-all")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Retry ALL failed jobs in a queue" })
  retryAll(@Param("queue") queue: string) {
    return this.admin.retryAllFailedJobs(queue);
  }

  @Delete("queues/:queue/failed/:jobId")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Discard and remove a failed job" })
  discardJob(@Param("queue") queue: string, @Param("jobId") jobId: string) {
    return this.admin.discardJob(queue, jobId);
  }

  // ── Webhook Events ─────────────────────────────────────

  @Get("webhooks")
  @ApiOperation({ summary: "Paginated webhook event log with filtering" })
  @ApiQuery({ name: "platform", required: false })
  @ApiQuery({ name: "hasError", required: false, type: Boolean, description: "Filter to events with processing errors" })
  @ApiQuery({ name: "from", required: false })
  @ApiQuery({ name: "to", required: false })
  @ApiQuery({ name: "page", required: false, type: Number })
  @ApiQuery({ name: "limit", required: false, type: Number })
  getWebhookEvents(
    @CurrentTenantId() tenantId: string,
    @Query("platform") platform?: string,
    @Query("hasError") hasError?: string,
    @Query("from") from?: string,
    @Query("to") to?: string,
    @Query("page", new DefaultValuePipe(1), ParseIntPipe) page?: number,
    @Query("limit", new DefaultValuePipe(50), ParseIntPipe) limit?: number,
  ) {
    return this.admin.getWebhookEvents({
      tenantId,
      platform,
      hasError: hasError !== undefined ? hasError === "true" : undefined,
      from: from ? new Date(from) : undefined,
      to: to ? new Date(to) : undefined,
      page,
      limit,
    });
  }

  @Post("webhooks/:eventId/replay")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Replay a specific webhook event" })
  replayWebhook(@Param("eventId") eventId: string) {
    return this.admin.replayWebhookEvent(eventId);
  }

  // ── Print Queue ────────────────────────────────────────

  @Get("print-jobs")
  @ApiOperation({ summary: "Print job queue viewer" })
  @ApiQuery({ name: "locationId", required: false })
  @ApiQuery({ name: "status", required: false })
  @ApiQuery({ name: "page", required: false, type: Number })
  @ApiQuery({ name: "limit", required: false, type: Number })
  getPrintQueue(
    @CurrentTenantId() tenantId: string,
    @Query("locationId") locationId?: string,
    @Query("status") status?: string,
    @Query("page", new DefaultValuePipe(1), ParseIntPipe) page?: number,
    @Query("limit", new DefaultValuePipe(50), ParseIntPipe) limit?: number,
  ) {
    return this.admin.getPrintQueue({ tenantId, locationId, status, page, limit });
  }

  // ── Integration Health ─────────────────────────────────

  @Get("integrations/health")
  @ApiOperation({ summary: "Integration health monitor — shows all integration statuses" })
  getIntegrationHealth(@CurrentTenantId() tenantId: string) {
    return this.admin.getIntegrationHealth(tenantId);
  }

  // ── Location Health ────────────────────────────────────

  @Get("locations/health")
  @ApiOperation({ summary: "Location health status — active orders, printers online, integrations" })
  getLocationHealth(@CurrentTenantId() tenantId: string) {
    return this.admin.getLocationHealth(tenantId);
  }
}
