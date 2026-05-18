import {
  Controller,
  Get,
  Post,
  Query,
  Param,
  Body,
  HttpCode,
  HttpStatus,
} from "@nestjs/common";
import { ApiTags, ApiOperation, ApiBearerAuth, ApiQuery } from "@nestjs/swagger";
import { AnalyticsService } from "./analytics.service";
import { CurrentUser } from "../../common/decorators/current-user.decorator";
import { Roles } from "../../common/decorators/roles.decorator";
import type { AuthenticatedUser } from "../auth/interfaces/jwt-payload.interface";

function parseDate(value: string | undefined, fallback: Date): Date {
  if (!value) return fallback;
  const d = new Date(value);
  return isNaN(d.getTime()) ? fallback : d;
}

function sevenDaysAgo(): Date {
  return new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
}

function thirtyDaysAgo(): Date {
  return new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
}

@ApiTags("analytics")
@ApiBearerAuth()
@Roles("MANAGER", "TENANT_OWNER", "PLATFORM_ADMIN")
@Controller({ path: "analytics", version: "1" })
export class AnalyticsController {
  constructor(private readonly analytics: AnalyticsService) {}

  // ── REAL-TIME DASHBOARD ─────────────────────────────────────────────────────

  @Get("dashboard")
  @ApiOperation({ summary: "Live dashboard — real-time order stats" })
  @ApiQuery({ name: "locationId", required: false })
  @ApiQuery({ name: "hoursBack", required: false, type: Number })
  getLiveDashboard(
    @CurrentUser() user: AuthenticatedUser,
    @Query("locationId") locationId?: string,
    @Query("hoursBack") hoursBack?: string,
  ) {
    return this.analytics.getLiveDashboard(
      user.tenantId,
      locationId,
      hoursBack ? parseInt(hoursBack, 10) : 24,
    );
  }

  // ── SALES ────────────────────────────────────────────────────────────────────

  @Get("sales")
  @ApiOperation({ summary: "Sales overview with optional granularity (day/week/month)" })
  @ApiQuery({ name: "locationId", required: false })
  @ApiQuery({ name: "startDate", required: false })
  @ApiQuery({ name: "endDate", required: false })
  @ApiQuery({ name: "granularity", required: false, enum: ["day", "week", "month"] })
  getSalesOverview(
    @CurrentUser() user: AuthenticatedUser,
    @Query("locationId") locationId?: string,
    @Query("startDate") startDate?: string,
    @Query("endDate") endDate?: string,
    @Query("granularity") granularity?: string,
  ) {
    const now = new Date();
    return this.analytics.getSalesOverview(user.tenantId, {
      locationId,
      startDate: parseDate(startDate, sevenDaysAgo()),
      endDate: parseDate(endDate, now),
      granularity: (granularity as "day" | "week" | "month") ?? "day",
    });
  }

  @Get("platforms")
  @ApiOperation({ summary: "Platform comparison — revenue, orders, cancellation rate" })
  @ApiQuery({ name: "locationId", required: false })
  @ApiQuery({ name: "startDate", required: false })
  @ApiQuery({ name: "endDate", required: false })
  getPlatformComparison(
    @CurrentUser() user: AuthenticatedUser,
    @Query("locationId") locationId?: string,
    @Query("startDate") startDate?: string,
    @Query("endDate") endDate?: string,
  ) {
    const now = new Date();
    return this.analytics.getPlatformComparison(user.tenantId, {
      locationId,
      startDate: parseDate(startDate, thirtyDaysAgo()),
      endDate: parseDate(endDate, now),
    });
  }

  @Get("locations")
  @ApiOperation({ summary: "Location comparison — revenue and order counts" })
  @ApiQuery({ name: "startDate", required: false })
  @ApiQuery({ name: "endDate", required: false })
  getLocationComparison(
    @CurrentUser() user: AuthenticatedUser,
    @Query("startDate") startDate?: string,
    @Query("endDate") endDate?: string,
  ) {
    const now = new Date();
    return this.analytics.getLocationComparison(
      user.tenantId,
      parseDate(startDate, thirtyDaysAgo()),
      parseDate(endDate, now),
    );
  }

  // ── ITEMS ─────────────────────────────────────────────────────────────────────

  @Get("items/top")
  @ApiOperation({ summary: "Top selling menu items" })
  @ApiQuery({ name: "locationId", required: false })
  @ApiQuery({ name: "startDate", required: false })
  @ApiQuery({ name: "endDate", required: false })
  @ApiQuery({ name: "limit", required: false, type: Number })
  getTopItems(
    @CurrentUser() user: AuthenticatedUser,
    @Query("locationId") locationId?: string,
    @Query("startDate") startDate?: string,
    @Query("endDate") endDate?: string,
    @Query("limit") limit?: string,
  ) {
    const now = new Date();
    return this.analytics.getTopItems(user.tenantId, {
      locationId,
      startDate: parseDate(startDate, thirtyDaysAgo()),
      endDate: parseDate(endDate, now),
      limit: limit ? parseInt(limit, 10) : 20,
    });
  }

  @Get("items/:menuItemId")
  @ApiOperation({ summary: "Daily performance breakdown for a specific menu item" })
  @ApiQuery({ name: "locationId", required: false })
  @ApiQuery({ name: "startDate", required: false })
  @ApiQuery({ name: "endDate", required: false })
  getItemPerformance(
    @Param("menuItemId") menuItemId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Query("locationId") locationId?: string,
    @Query("startDate") startDate?: string,
    @Query("endDate") endDate?: string,
  ) {
    const now = new Date();
    return this.analytics.getItemPerformance(user.tenantId, menuItemId, {
      locationId,
      startDate: parseDate(startDate, thirtyDaysAgo()),
      endDate: parseDate(endDate, now),
    });
  }

  // ── CUSTOMERS ─────────────────────────────────────────────────────────────────

  @Get("customers")
  @ApiOperation({ summary: "Customer metrics — new vs returning, top spenders" })
  @ApiQuery({ name: "startDate", required: false })
  @ApiQuery({ name: "endDate", required: false })
  getCustomerMetrics(
    @CurrentUser() user: AuthenticatedUser,
    @Query("startDate") startDate?: string,
    @Query("endDate") endDate?: string,
  ) {
    const now = new Date();
    return this.analytics.getCustomerMetrics(user.tenantId, {
      startDate: parseDate(startDate, thirtyDaysAgo()),
      endDate: parseDate(endDate, now),
    });
  }

  @Get("loyalty")
  @ApiOperation({ summary: "Loyalty program analytics — tier distribution, points" })
  getLoyalty(@CurrentUser() user: AuthenticatedUser) {
    return this.analytics.getLoyaltyAnalytics(user.tenantId);
  }

  // ── OPERATIONAL ───────────────────────────────────────────────────────────────

  @Get("kitchen-sla")
  @ApiOperation({ summary: "Kitchen SLA — prep time percentiles and over-SLA rate" })
  @ApiQuery({ name: "locationId", required: false })
  @ApiQuery({ name: "startDate", required: false })
  @ApiQuery({ name: "endDate", required: false })
  getKitchenSla(
    @CurrentUser() user: AuthenticatedUser,
    @Query("locationId") locationId?: string,
    @Query("startDate") startDate?: string,
    @Query("endDate") endDate?: string,
  ) {
    const now = new Date();
    return this.analytics.getKitchenSla(user.tenantId, locationId, {
      startDate: parseDate(startDate, sevenDaysAgo()),
      endDate: parseDate(endDate, now),
    });
  }

  @Get("cancellations")
  @ApiOperation({ summary: "Cancellation analytics — by reason and platform" })
  @ApiQuery({ name: "locationId", required: false })
  @ApiQuery({ name: "startDate", required: false })
  @ApiQuery({ name: "endDate", required: false })
  getCancellations(
    @CurrentUser() user: AuthenticatedUser,
    @Query("locationId") locationId?: string,
    @Query("startDate") startDate?: string,
    @Query("endDate") endDate?: string,
  ) {
    const now = new Date();
    return this.analytics.getCancellationAnalytics(user.tenantId, {
      locationId,
      startDate: parseDate(startDate, thirtyDaysAgo()),
      endDate: parseDate(endDate, now),
    });
  }

  @Get("drivers")
  @ApiOperation({ summary: "Driver delivery metrics" })
  @ApiQuery({ name: "startDate", required: false })
  @ApiQuery({ name: "endDate", required: false })
  getDrivers(
    @CurrentUser() user: AuthenticatedUser,
    @Query("startDate") startDate?: string,
    @Query("endDate") endDate?: string,
  ) {
    const now = new Date();
    return this.analytics.getDriverMetrics(user.tenantId, {
      startDate: parseDate(startDate, thirtyDaysAgo()),
      endDate: parseDate(endDate, now),
    });
  }

  // ── LEGACY ENDPOINTS (preserved) ─────────────────────────────────────────────

  @Get("prep-times")
  @ApiOperation({ summary: "Average acceptance and preparation times (legacy)" })
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
    return this.analytics.getAvgPrepTimes(user.tenantId, {
      locationId,
      from: parseDate(from, sevenDaysAgo()),
      to: parseDate(to, now),
    });
  }

  @Get("hubrise-audit")
  @ApiOperation({ summary: "HubRise vs direct order split audit (legacy)" })
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
    return this.analytics.getHubriseAudit(user.tenantId, {
      locationId,
      from: parseDate(from, thirtyDaysAgo()),
      to: parseDate(to, now),
    });
  }

  // ── SNAPSHOT TRIGGERS ─────────────────────────────────────────────────────────

  @Post("snapshots/daily")
  @Roles("TENANT_OWNER", "PLATFORM_ADMIN")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Trigger daily snapshot generation for a location/date" })
  triggerDailySnapshot(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: { locationId: string; date?: string },
  ) {
    const date = body.date ? new Date(body.date) : new Date();
    return this.analytics.generateDailySnapshot(user.tenantId, body.locationId, date);
  }
}
