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
} from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";
import { CurrentUser } from "../../../common/decorators/current-user.decorator";
import { Public } from "../../../common/decorators/public.decorator";
import { Roles, TILL_ROLES } from "../../../common/decorators/roles.decorator";
import type { AuthenticatedUser } from "../../auth/interfaces/jwt-payload.interface";
import { DojoService } from "./dojo.service";

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
export class DojoController {
  private readonly logger = new Logger(DojoController.name);

  constructor(private readonly dojo: DojoService) {}

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
