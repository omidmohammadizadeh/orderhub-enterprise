import { Controller, Get, Query } from "@nestjs/common";
import { ApiTags, ApiOperation, ApiBearerAuth, ApiQuery } from "@nestjs/swagger";
import { AnalyticsService } from "./analytics.service";
import { CurrentUser } from "../../common/decorators/current-user.decorator";
import type { AuthenticatedUser } from "../auth/interfaces/jwt-payload.interface";

function parseDateOrDefault(value: string | undefined, fallback: Date): Date {
  if (!value) return fallback;
  const d = new Date(value);
  return isNaN(d.getTime()) ? fallback : d;
}

@ApiTags("analytics")
@ApiBearerAuth()
@Controller({ path: "analytics", version: "1" })
export class AnalyticsController {
  constructor(private readonly analytics: AnalyticsService) {}

  @Get("sales")
  @ApiOperation({ summary: "Sales summary with platform and fulfillment breakdown" })
  @ApiQuery({ name: "locationId", required: false })
  @ApiQuery({ name: "from", required: false })
  @ApiQuery({ name: "to", required: false })
  getSales(
    @CurrentUser() user: AuthenticatedUser,
    @Query("locationId") locationId?: string,
    @Query("from") from?: string,
    @Query("to") to?: string,
  ) {
    const now = new Date();
    const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    return this.analytics.getSalesSummary(user.tenantId, {
      locationId,
      from: parseDateOrDefault(from, sevenDaysAgo),
      to: parseDateOrDefault(to, now),
    });
  }

  @Get("cancellations")
  @ApiOperation({ summary: "Cancellation rate and breakdown by reason" })
  @ApiQuery({ name: "locationId", required: false })
  @ApiQuery({ name: "from", required: false })
  @ApiQuery({ name: "to", required: false })
  getCancellations(
    @CurrentUser() user: AuthenticatedUser,
    @Query("locationId") locationId?: string,
    @Query("from") from?: string,
    @Query("to") to?: string,
  ) {
    const now = new Date();
    const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    return this.analytics.getCancellationMetrics(user.tenantId, {
      locationId,
      from: parseDateOrDefault(from, sevenDaysAgo),
      to: parseDateOrDefault(to, now),
    });
  }

  @Get("prep-times")
  @ApiOperation({ summary: "Average acceptance and preparation times" })
  @ApiQuery({ name: "locationId", required: false })
  @ApiQuery({ name: "from", required: false })
  @ApiQuery({ name: "to", required: false })
  getPrepTimes(
    @CurrentUser() user: AuthenticatedUser,
    @Query("locationId") locationId?: string,
    @Query("from") from?: string,
    @Query("to") to?: string,
  ) {
    const now = new Date();
    const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    return this.analytics.getAvgPrepTimes(user.tenantId, {
      locationId,
      from: parseDateOrDefault(from, sevenDaysAgo),
      to: parseDateOrDefault(to, now),
    });
  }

  @Get("hubrise-audit")
  @ApiOperation({ summary: "HubRise vs direct order split audit" })
  @ApiQuery({ name: "locationId", required: false })
  @ApiQuery({ name: "from", required: false })
  @ApiQuery({ name: "to", required: false })
  getHubriseAudit(
    @CurrentUser() user: AuthenticatedUser,
    @Query("locationId") locationId?: string,
    @Query("from") from?: string,
    @Query("to") to?: string,
  ) {
    const now = new Date();
    const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    return this.analytics.getHubriseAudit(user.tenantId, {
      locationId,
      from: parseDateOrDefault(from, thirtyDaysAgo),
      to: parseDateOrDefault(to, now),
    });
  }
}
