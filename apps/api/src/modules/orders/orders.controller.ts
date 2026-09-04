import {
  Controller,
  Get,
  Post,
  Patch,
  Body,
  Param,
  Query,
  HttpCode,
  HttpStatus, ForbiddenException } from "@nestjs/common";
import {
  ApiTags,
  ApiOperation,
  ApiBearerAuth,
  ApiQuery,
  ApiResponse,
} from "@nestjs/swagger";
import { OrdersService, OrderFilters } from "./orders.service";
import { VoidItemsService } from "./void-items.service";
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
// POS_MANAGER — supervisory actions (the manager PIN, creating a test order):
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
  constructor(
    private readonly orders: OrdersService,
    private readonly voidItems: VoidItemsService,
  ) {}

  // ── Void / comp a line, gated on a manager PIN ──────────────────────
  @Post("locations/:locationId/manager-pin")
  @Roles(...POS_MANAGER)
  @ApiOperation({ summary: "Set this location's manager PIN (stored hashed)" })
  setManagerPin(
    @Param("locationId") locationId: string,
    @Body() body: { pin: string },
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.voidItems.setManagerPin(user.tenantId, locationId, body.pin);
  }

  @Get("locations/:locationId/manager-pin")
  @Roles(...POS_STAFF)
  @ApiOperation({ summary: "Is a manager PIN configured here?" })
  managerPinConfigured(
    @Param("locationId") locationId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.voidItems.hasManagerPin(user.tenantId, locationId);
  }

  @Post(":id/items/:itemId/void")
  @Roles(...POS_STAFF)
  @ApiOperation({ summary: "Void or comp one line off an unpaid bill" })
  voidLine(
    @Param("id") id: string,
    @Param("itemId") itemId: string,
    @Body() body: { pin: string; reason: string; type?: "VOID" | "COMP" },
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.voidItems.voidItem({
      tenantId: user.tenantId,
      orderId: id,
      itemId,
      pin: body.pin,
      reason: body.reason,
      type: body.type ?? "VOID",
      userId: user.userId ?? "staff",
    });
  }

  // ── POST /api/v1/orders ───────────────────────────────
  // KIOSK is granted here and NOWHERE else in this controller: a self-service
  // screen must be able to place an order, but not refund one, void a line,
  // or change a payment status. Adding it to POS_STAFF would have handed it
  // all three.
  @Post()
  @Roles(...POS_STAFF, "KIOSK")
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
      /** Simulate a marketplace order. Platform admins only — see below. */
      platform?: "DELIVEROO" | "UBER_EATS" | "JUST_EAT";
      /** Walk it through assigned → out for delivery → delivered. */
      withDriver?: boolean;
    },
    @CurrentUser() user: AuthenticatedUser,
  ) {
    // A simulated Deliveroo/Uber/Just Eat order lands on a real shop's board
    // looking exactly like the real thing, which is the point — and the
    // reason a manager must not be able to make one. The @Roles decorator
    // above already admits POS_MANAGER for the ordinary DIRECT test order, so
    // the narrower rule is enforced here rather than by widening that.
    if (body.platform && user.role !== "PLATFORM_ADMIN") {
      throw new ForbiddenException(
        "Simulated marketplace orders are restricted to platform admins.",
      );
    }
    return this.orders.createTest(user.tenantId, body.locationId, user.userId, {
      customerName: body.customerName,
      fulfillmentType: body.fulfillmentType,
      platform: body.platform,
      withDriver: body.withDriver === true,
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
  // Amending a POS order the customer changed their mind about.
  // Constraints (status, payment, source) are enforced in the service too —
  // this gate is just for permissions.
  //
  // POS_STAFF, not POS_MANAGER. Whoever took the order at the till is the one
  // standing there when the customer adds chips, and a cashier who cannot
  // amend has to cancel and re-key the whole order instead — which is worse
  // for the till and worse for the customer. The genuinely dangerous edits are
  // already blocked by the service for everyone: a PAID card order can't be
  // amended, and neither can one past READY. Voiding a line still needs the
  // manager PIN.
  @Patch(":id/edit")
  @Roles(...POS_STAFF)
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

  // ── POST /api/v1/orders/:id/print-bill ───────────────
  // Table Tabs — print the customer's bill ("the check") before payment.
  // Receipt printer only, TO PAY banner, repeatable.
  @Post(":id/print-bill")
  @Roles(...POS_STAFF)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Print the bill for a table tab (unpaid check)" })
  async printBill(
    @Param("id") id: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    const jobIds = await this.orders.printBill(id, user.tenantId);
    return { printed: jobIds.length, jobIds };
  }

  // ── Split the bill ───────────────────────────────────
  // GET  payments  → what's been paid and what's still owed
  // POST payments  → record one part-payment (cash or card)
  @Get(":id/payments")
  @Roles(...POS_STAFF)
  @ApiOperation({ summary: "Payments taken on a tab + remaining balance" })
  paymentSummary(
    @Param("id") id: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.orders.paymentSummary(id, user.tenantId);
  }

  @Post(":id/payments")
  @Roles(...POS_STAFF)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Record a part-payment against a tab (split bill)" })
  addPayment(
    @Param("id") id: string,
    @Body()
    dto: {
      amount: number;
      method: "CASH" | "CARD";
      note?: string;
      // Present when the part was paid "by item" — lets the till cross
      // those lines off and refuse to charge them again.
      itemIds?: string[];
    },
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.orders.addPayment(id, user.tenantId, dto, user.userId);
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
    @Body()
    body: {
      paymentStatus: "PAID" | "PENDING" | "FAILED";
      paymentMethod?: string;
    },
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.orders.setPaymentStatus(
      id,
      user.tenantId,
      body.paymentStatus,
      body.paymentMethod,
    );
  }
}
