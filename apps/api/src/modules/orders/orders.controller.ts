import {
  Controller,
  Get,
  Post,
  Patch,
  Body,
  Param,
  Query,
  HttpCode,
  HttpStatus,
  ParseUUIDPipe,
} from "@nestjs/common";
import {
  ApiTags,
  ApiOperation,
  ApiBearerAuth,
  ApiQuery,
  ApiResponse,
} from "@nestjs/swagger";
import { OrdersService, OrderFilters } from "./orders.service";
import { CreateOrderDto } from "./dto/create-order.dto";
import { UpdateOrderStatusDto } from "./dto/update-order-status.dto";
import { CurrentUser } from "../../common/decorators/current-user.decorator";
import { Roles } from "../../common/decorators/roles.decorator";
import { BillingExempt } from "../../common/guards/billing.guard";
import type { AuthenticatedUser } from "../auth/interfaces/jwt-payload.interface";

@ApiTags("orders")
@ApiBearerAuth()
@BillingExempt() // Live order operations must never be blocked by billing status
@Controller({ path: "orders", version: "1" })
export class OrdersController {
  constructor(private readonly orders: OrdersService) {}

  // ── POST /api/v1/orders ───────────────────────────────
  @Post()
  @Roles("CASHIER", "MANAGER", "TENANT_OWNER", "PLATFORM_ADMIN")
  @ApiOperation({ summary: "Create a direct / POS order" })
  @ApiResponse({ status: 201 })
  async create(
    @Body() dto: CreateOrderDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.orders.create(dto, user.tenantId);
  }

  // ── POST /api/v1/orders/test ──────────────────────────
  // Phase AJ — creates a single sandbox order at the given location.
  // Available to MANAGER+ so operators can verify printer/board wiring
  // without involving a live delivery platform. Marked isSandbox=true so
  // it can be cleared via the sandbox endpoint and excluded from reports.
  @Post("test")
  @Roles("MANAGER", "TENANT_OWNER", "PLATFORM_ADMIN")
  @ApiOperation({ summary: "Create a sandbox test order (Phase AJ)" })
  @ApiResponse({ status: 201 })
  async createTest(
    @Body()
    body: {
      locationId: string;
      customerName?: string;
      fulfillmentType?: "PICKUP" | "DELIVERY";
    },
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.orders.createTest(user.tenantId, body.locationId, user.userId, {
      customerName: body.customerName,
      fulfillmentType: body.fulfillmentType,
    });
  }

  // ── GET /api/v1/orders ────────────────────────────────
  @Get()
  @ApiOperation({ summary: "List orders with filters" })
  @ApiQuery({ name: "locationId", required: false })
  @ApiQuery({ name: "status", required: false })
  @ApiQuery({ name: "platform", required: false })
  @ApiQuery({ name: "orderSource", required: false })
  @ApiQuery({ name: "from", required: false })
  @ApiQuery({ name: "to", required: false })
  @ApiQuery({ name: "page", required: false, type: Number })
  @ApiQuery({ name: "limit", required: false, type: Number })
  async findMany(
    @CurrentUser() user: AuthenticatedUser,
    @Query("locationId") locationId?: string,
    @Query("status") status?: string,
    @Query("platform") platform?: string,
    @Query("orderSource") orderSource?: string,
    @Query("from") from?: string,
    @Query("to") to?: string,
    @Query("page") page?: string,
    @Query("limit") limit?: string,
  ) {
    // Parse comma-separated status values: "PENDING,ACCEPTED" → ["PENDING", "ACCEPTED"]
    const parsedStatus = status
      ? status.includes(",")
        ? (status.split(",").map((s) => s.trim()) as any)
        : (status as any)
      : undefined;

    const filters: OrderFilters = {
      locationId,
      status: parsedStatus,
      platform,
      orderSource,
      from: from ? new Date(from) : undefined,
      to: to ? new Date(to) : undefined,
      page: page ? parseInt(page, 10) : 1,
      limit: limit ? Math.min(parseInt(limit, 10), 200) : 50,
    };
    return this.orders.findMany(user.tenantId, filters);
  }

  // ── GET /api/v1/orders/live ───────────────────────────
  @Get("live")
  @ApiOperation({ summary: "Get live (in-progress) orders" })
  @ApiQuery({ name: "locationId", required: false })
  async findLive(
    @CurrentUser() user: AuthenticatedUser,
    @Query("locationId") locationId?: string,
  ) {
    return this.orders.findLiveOrders(user.tenantId, locationId);
  }

  // ── GET /api/v1/orders/:id ────────────────────────────
  @Get(":id")
  @ApiOperation({ summary: "Get single order with full relations" })
  async findOne(
    @Param("id", ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.orders.findOne(id, user.tenantId);
  }

  // ── PATCH /api/v1/orders/:id/status ──────────────────
  @Patch(":id/status")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Transition order status" })
  async updateStatus(
    @Param("id", ParseUUIDPipe) id: string,
    @Body() dto: UpdateOrderStatusDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.orders.updateStatus(id, user.tenantId, dto, user.userId);
  }
}
