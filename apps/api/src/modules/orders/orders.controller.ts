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
import { EditOrderDto } from "./dto/edit-order.dto";
import { UpdateOrderStatusDto } from "./dto/update-order-status.dto";
import { CurrentUser } from "../../common/decorators/current-user.decorator";
import { Roles } from "../../common/decorators/roles.decorator";
import { BillingExempt } from "../../common/guards/billing.guard";
import type { AuthenticatedUser } from "../auth/interfaces/jwt-payload.interface";
import type { UserRole } from "@orderhub/database";

// Role tiers for POS/order operations. The schema carries BOTH the legacy role
// names (TENANT_OWNER, CASHIER…) and the newer Team-Roles names (OWNER, STAFF,
// DARK_KITCHEN_MANAGER) which coexist — a user assigned a Team Role was being
// 403'd by decorators that only listed the legacy names. These tiers list both
// so every equivalent role can operate the POS.
//
// POS_STAFF — anyone who can take an order at the till: admin, owner, manager,
// dark-kitchen manager, and front-line staff/cashier.
const POS_STAFF: UserRole[] = [
  "PLATFORM_ADMIN",
  "TENANT_OWNER",
  "OWNER",
  "MANAGER",
  "DARK_KITCHEN_MANAGER",
  "CASHIER",
  "STAFF",
];
// POS_MANAGER — supervisory actions (edit an order, create a test order):
// everyone above except front-line staff/cashier.
const POS_MANAGER: UserRole[] = [
  "PLATFORM_ADMIN",
  "TENANT_OWNER",
  "OWNER",
  "MANAGER",
  "DARK_KITCHEN_MANAGER",
];

@ApiTags("orders")
@ApiBearerAuth()
@BillingExempt() // Live order operations must never be blocked by billing status
@Controller({ path: "orders", version: "1" })
export class OrdersController {
  constructor(private readonly orders: OrdersService) {}

  // ── POST /api/v1/orders ───────────────────────────────
  @Post()
  @Roles(...POS_STAFF)
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
  @Roles(...POS_MANAGER)
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
    return this.orders.findMany(user, filters);
  }

  // ── GET /api/v1/orders/live ───────────────────────────
  @Get("live")
  @ApiOperation({ summary: "Get live (in-progress) orders" })
  @ApiQuery({ name: "locationId", required: false })
  async findLive(
    @CurrentUser() user: AuthenticatedUser,
    @Query("locationId") locationId?: string,
  ) {
    return this.orders.findLiveOrders(user, locationId);
  }

  // ── GET /api/v1/orders/scheduled ──────────────────────
  // Phase AM — orders placed via POS with a future scheduledAt that haven't
  // been started yet. Rendered in their own Scheduled section on the board.
  @Get("scheduled")
  @ApiOperation({ summary: "List POS scheduled-for-later orders" })
  @ApiQuery({ name: "locationId", required: false })
  async findScheduled(
    @CurrentUser() user: AuthenticatedUser,
    @Query("locationId") locationId?: string,
  ) {
    return this.orders.findScheduledOrders(user, locationId);
  }

  // ── POST /api/v1/orders/:id/start-preparing ───────────
  // Phase AM — operator clicks "Start preparing now" on a scheduled order.
  // Transitions PENDING → ACCEPTED (triggering the print pipeline).
  @Post(":id/start-preparing")
  @HttpCode(HttpStatus.OK)
  @Roles(...POS_STAFF)
  @ApiOperation({ summary: "Start preparing a scheduled order now" })
  async startPreparing(
    @Param("id") id: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.orders.startPreparingScheduled(id, user.tenantId, user.userId);
  }

  // ── GET /api/v1/orders/:id ────────────────────────────
  // NB: Order IDs are CUIDs (e.g. cmpq1e03l008mqany6rqw140h), NOT UUIDs.
  // Using ParseUUIDPipe here would 400 every request with "uuid is expected"
  // before the handler ever ran. The tenant scope on the service layer is
  // what enforces access control.
  @Get(":id")
  @ApiOperation({ summary: "Get single order with full relations" })
  async findOne(
    @Param("id") id: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.orders.findOne(id, user.tenantId);
  }

  // ── PATCH /api/v1/orders/:id/edit ────────────────────
  // Phase AW-22 — Manager amends a POS order the customer rang back
  // about. Constraints (status, payment, source) enforced server-
  // side too — this gate is just for permissions.
  @Patch(":id/edit")
  @Roles(...POS_MANAGER)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      "Replace line items + customer info on a POS order (cash, pre-Ready). Reprints ticket.",
  })
  async edit(
    @Param("id") id: string,
    @Body() dto: EditOrderDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.orders.editOrder(id, user.tenantId, dto, user.userId);
  }

  // ── POST /api/v1/orders/:id/rounds ───────────────────
  // Table Tabs — add a round of items to an open dine-in tab. APPENDS (keeps
  // prior items + their KDS states) and fires only the new items to the
  // kitchen, unlike /edit which replaces everything.
  @Post(":id/rounds")
  @Roles(...POS_STAFF)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Add a round of items to an open table tab" })
  async addRound(
    @Param("id") id: string,
    @Body()
    dto: {
      items: Array<{
        name: string;
        quantity: number;
        unitPrice: number;
        totalPrice: number;
        modifiers?: { name: string; price: number; quantity?: number }[];
        notes?: string | null;
        menuItemId?: string | null;
      }>;
    },
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.orders.addRound(id, user.tenantId, dto.items, user.userId);
  }

  // ── PATCH /api/v1/orders/:id/status ──────────────────
  @Patch(":id/status")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Transition order status" })
  async updateStatus(
    @Param("id") id: string,
    @Body() dto: UpdateOrderStatusDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.orders.updateStatus(id, user.tenantId, dto, user.userId);
  }

  // ── PATCH /api/v1/orders/:id/payment-status ──────────
  // Operator marks a POS order paid/unpaid (e.g. paid on a separate card
  // terminal). The Stripe Terminal flow settles PAID automatically; this is
  // the manual fallback.
  @Patch(":id/payment-status")
  @Roles(...POS_STAFF)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Set an order's payment status (PAID / PENDING)" })
  async setPaymentStatus(
    @Param("id") id: string,
    @Body() body: { paymentStatus: "PAID" | "PENDING" | "FAILED" },
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.orders.setPaymentStatus(id, user.tenantId, body.paymentStatus);
  }
}
