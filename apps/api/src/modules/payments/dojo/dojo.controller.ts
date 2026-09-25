import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Logger,
  Param,
  Patch,
  Post,
  Query,
  UseFilters,
} from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";
import { CurrentUser } from "../../../common/decorators/current-user.decorator";
import { Public } from "../../../common/decorators/public.decorator";
import { Roles, TILL_ROLES } from "../../../common/decorators/roles.decorator";
import type { AuthenticatedUser } from "../../auth/interfaces/jwt-payload.interface";
import { DojoApiExceptionFilter } from "./dojo-api-exception.filter";
import { DojoService } from "./dojo.service";
import { DojoEposService } from "./dojo-epos.service";

// Connecting Dojo stores a key that moves a shop's money, so it's the same
// list as registering a Stripe reader — plus the Team Roles equivalents,
// which only ever pass by exact match (see TILL_ROLES for that lesson).
const DOJO_ADMIN_ROLES = [
  "MANAGER",
  "TENANT_OWNER",
  "PLATFORM_ADMIN",
  "OWNER",
  "DARK_KITCHEN_MANAGER",
] as const;

@ApiTags("payments")
@ApiBearerAuth()
@Controller({ path: "payments/dojo", version: "1" })
// Dojo saying no is not us falling over — see the filter.
@UseFilters(DojoApiExceptionFilter)
export class DojoController {
  private readonly logger = new Logger(DojoController.name);

  constructor(
    private readonly dojo: DojoService,
    private readonly epos: DojoEposService,
  ) {}

  // ── Setup (card-readers settings page) ────────────────────────────────────

  @Get("locations/:locationId")
  @Roles(...TILL_ROLES)
  @ApiOperation({ summary: "Dojo connection + live card machine list for a location" })
  status(@Param("locationId") locationId: string, @CurrentUser() user: AuthenticatedUser) {
    return this.dojo.status(user.tenantId, locationId);
  }

  @Post("locations/:locationId/connect")
  @Roles(...DOJO_ADMIN_ROLES)
  @ApiOperation({ summary: "Connect a location's Dojo account with its secret API key" })
  connect(
    @Param("locationId") locationId: string,
    @Body() body: { apiKey: string },
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.dojo.connect(user.tenantId, locationId, body?.apiKey ?? "");
  }

  @Delete("locations/:locationId")
  @Roles(...DOJO_ADMIN_ROLES)
  @ApiOperation({ summary: "Disconnect Dojo from a location" })
  disconnect(@Param("locationId") locationId: string, @CurrentUser() user: AuthenticatedUser) {
    return this.dojo.disconnect(user.tenantId, locationId);
  }

  @Patch("locations/:locationId/terminals/:terminalId")
  @Roles(...DOJO_ADMIN_ROLES)
  @ApiOperation({ summary: "Name a Dojo card machine" })
  rename(
    @Param("locationId") locationId: string,
    @Param("terminalId") terminalId: string,
    @Body() body: { label: string },
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.dojo.renameTerminal(user.tenantId, locationId, terminalId, body?.label ?? "");
  }

  @Post("locations/:locationId/pay-at-table")
  @Roles(...DOJO_ADMIN_ROLES)
  @ApiOperation({ summary: "Turn on Dojo Pay at Table (registers our EPOS endpoints with Dojo)" })
  enablePayAtTable(@Param("locationId") locationId: string, @CurrentUser() user: AuthenticatedUser) {
    return this.dojo.enablePayAtTable(user.tenantId, locationId);
  }

  @Delete("locations/:locationId/pay-at-table")
  @Roles(...DOJO_ADMIN_ROLES)
  @ApiOperation({ summary: "Turn off Dojo Pay at Table" })
  disablePayAtTable(@Param("locationId") locationId: string, @CurrentUser() user: AuthenticatedUser) {
    return this.dojo.disablePayAtTable(user.tenantId, locationId);
  }

  /**
   * "What would Dojo see?" — runs OUR OWN Pay at Table handlers and returns
   * their answers.
   *
   * A virtual card machine can't drive Pay at Table: the VCMs simulate payment
   * outcomes, not the waiter's table menu, which is a separate application on
   * a physical terminal. Without hardware there is no other way to find out
   * whether the areas, tables, open tabs and bill we hand Dojo are right.
   *
   * Be clear about the limit: this skips HTTP, Basic auth and the terminal
   * entirely, so a green result here does NOT mean Pay at Table works — only
   * that the half we own is correct. The response says so, because a
   * diagnostic that overstates itself is worse than none.
   */
  @Get("locations/:locationId/pay-at-table/preview")
  @Roles(...DOJO_ADMIN_ROLES)
  @ApiOperation({ summary: "Preview the data Dojo's table app would receive" })
  async previewPayAtTable(
    @Param("locationId") locationId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Query("tableId") tableId?: string,
  ) {
    const { ctx, payAtTableEnabled } = await this.dojo.eposPreviewContext(
      user.tenantId,
      locationId,
    );
    const step = async <T>(name: string, run: () => Promise<T>) => {
      try {
        return { name, ok: true as const, data: await run() };
      } catch (err: any) {
        // One failing step must not hide the others — the point is to see
        // which part of the chain is wrong.
        return { name, ok: false as const, error: err?.message ?? String(err) };
      }
    };

    const areas = await step("ListAreas", () => this.epos.listAreas(ctx));
    const tables = await step("SearchTables", () =>
      this.epos.searchTables(ctx, {}),
    );
    const orders = await step("SearchOrders", () =>
      this.epos.searchOrders(ctx, tableId ? { dineIn: { tableId } } : {}),
    );
    // The bill is the screen the customer actually reads, so preview the
    // first open tab's rather than stopping at the list.
    const firstOrderId =
      orders.ok && Array.isArray((orders.data as any)?.data)
        ? (orders.data as any).data[0]?.id
        : undefined;
    const bill = firstOrderId
      ? await step("GetOrderBillById", () => this.epos.getBill(ctx, firstOrderId))
      : { name: "GetOrderBillById", ok: false as const, error: "No open table tab to bill." };

    return {
      payAtTableEnabled,
      // Said plainly so nobody reads a pass here as "Pay at Table works".
      proves:
        "The data our endpoints return. NOT the HTTP layer, the Basic auth, or the terminal itself — those need a real card machine.",
      steps: [areas, tables, orders, bill],
    };
  }

  // ── Taking a payment at the counter ───────────────────────────────────────

  @Post("charge")
  @Roles(...TILL_ROLES)
  @ApiOperation({ summary: "Send an order (or a split share) to a Dojo card machine" })
  charge(
    @Body() body: { orderId: string; terminalId: string; amount?: number },
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.dojo.chargeOrder({
      tenantId: user.tenantId,
      orderId: body.orderId,
      terminalId: body.terminalId,
      amount: body.amount,
    });
  }

  @Get("charge/status")
  @Roles(...TILL_ROLES)
  @ApiOperation({ summary: "Poll a Dojo card machine payment; settles the order when paid" })
  chargeStatus(
    @Query("paymentIntentId") paymentIntentId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.dojo.chargeStatus(user.tenantId, paymentIntentId);
  }

  @Post("charge/cancel")
  @Roles(...TILL_ROLES)
  @ApiOperation({ summary: "Cancel a payment that's waiting on the card machine" })
  cancel(@Body() body: { paymentIntentId: string }, @CurrentUser() user: AuthenticatedUser) {
    return this.dojo.cancelCharge(user.tenantId, body.paymentIntentId);
  }

  @Post("charge/signature")
  @Roles(...TILL_ROLES)
  @ApiOperation({ summary: "Accept or reject the customer's signature on the card machine" })
  signature(
    @Body() body: { paymentIntentId: string; accepted: boolean },
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.dojo.respondToSignature(user.tenantId, body.paymentIntentId, body.accepted === true);
  }

  // Money going back out — manager tier, like the rest of the Dojo setup.
  // NOTE the path: PaymentsController owns `payments/:paymentId/refund`, and it
  // is registered first, so a plain `refund` here is swallowed by it with
  // paymentId="dojo" and every refund 404s "Payment not found". Keep Dojo's
  // refund inside the charge/* family, which nothing else can match.
  @Post("charge/refund")
  @Roles(...DOJO_ADMIN_ROLES)
  @ApiOperation({ summary: "Refund a Dojo card payment (full, or partial with `amount`)" })
  refund(
    @Body() body: { paymentIntentId: string; amount?: number; reason?: string },
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.dojo.refundPayment({
      tenantId: user.tenantId,
      paymentIntentId: body.paymentIntentId,
      amount: body.amount,
      reason: body.reason,
      userId: user.userId,
    });
  }

  // Card-present refunds run ON the machine — same shape as taking a payment:
  // start a session, then poll it. (Path stays inside charge/* so it can't be
  // swallowed by payments/:paymentId/refund — see the note on `charge/refund`.)
  @Post("charge/refund/terminal")
  @Roles(...DOJO_ADMIN_ROLES)
  @ApiOperation({ summary: "Start a refund on the card machine (customer's card must be present)" })
  startTerminalRefund(
    @Body() body: { paymentIntentId: string; terminalId?: string; amount?: number; reason?: string },
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.dojo.startTerminalRefund({
      tenantId: user.tenantId,
      paymentIntentId: body.paymentIntentId,
      terminalId: body.terminalId,
      amount: body.amount,
      reason: body.reason,
      userId: user.userId,
    });
  }

  @Get("charge/refund/status")
  @Roles(...DOJO_ADMIN_ROLES)
  @ApiOperation({ summary: "Poll a card-machine refund" })
  terminalRefundStatus(@Query("paymentIntentId") paymentIntentId: string, @CurrentUser() user: AuthenticatedUser) {
    return this.dojo.terminalRefundStatus(user.tenantId, paymentIntentId);
  }

  // ── Webhook ───────────────────────────────────────────────────────────────

  /**
   * Public, and deliberately powerless: it only makes us RE-CHECK a payment
   * with Dojo using the shop's own key. Always 200 so Dojo doesn't retry
   * something that will never match.
   */
  @Post("webhook/:locationId")
  @Public()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Dojo webhook (re-verifies the payment with Dojo before acting)" })
  async webhook(@Param("locationId") locationId: string, @Body() body: unknown) {
    await this.dojo
      .handleWebhook(locationId, body)
      .catch((err: any) => this.logger.error(`Dojo webhook for ${locationId} failed: ${err?.message}`));
    return { received: true };
  }
}
