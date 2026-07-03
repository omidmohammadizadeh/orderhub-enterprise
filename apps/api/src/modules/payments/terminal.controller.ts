import { Controller, Get, Post, Delete, Body, Param, Query } from "@nestjs/common";
import { ApiTags, ApiOperation, ApiBearerAuth } from "@nestjs/swagger";
import { TerminalService } from "./terminal.service";
import { CurrentUser } from "../../common/decorators/current-user.decorator";
import { Roles } from "../../common/decorators/roles.decorator";
import type { AuthenticatedUser } from "../auth/interfaces/jwt-payload.interface";

// Stripe Terminal (S700 / WisePOS E) — server-driven card-present payments.
@ApiTags("payments")
@ApiBearerAuth()
@Controller({ path: "payments/terminal", version: "1" })
export class TerminalController {
  constructor(private readonly terminal: TerminalService) {}

  @Get("locations/:locationId/readers")
  @ApiOperation({ summary: "List card readers registered at a location" })
  async listReaders(
    @Param("locationId") locationId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    const data = await this.terminal.listReaders(user.tenantId, locationId);
    return { ...data, testMode: this.terminal.isTestMode };
  }

  @Post("locations/:locationId/readers")
  @Roles("MANAGER", "TENANT_OWNER", "PLATFORM_ADMIN")
  @ApiOperation({
    summary:
      "Register a card reader by its on-screen registration code (Settings → Register on the S700)",
  })
  registerReader(
    @Param("locationId") locationId: string,
    @Body() body: { registrationCode: string; label?: string },
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.terminal.registerReader({
      tenantId: user.tenantId,
      locationId,
      registrationCode: body.registrationCode,
      label: body.label,
    });
  }

  @Post("locations/:locationId/readers/simulated")
  @Roles("MANAGER", "TENANT_OWNER", "PLATFORM_ADMIN")
  @ApiOperation({
    summary: "Register Stripe's simulated reader (test mode) — no hardware needed",
  })
  registerSimulated(
    @Param("locationId") locationId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.terminal.registerSimulatedReader(user.tenantId, locationId);
  }

  @Delete("locations/:locationId/readers/:readerId")
  @Roles("MANAGER", "TENANT_OWNER", "PLATFORM_ADMIN")
  @ApiOperation({ summary: "Remove a card reader from a location" })
  removeReader(
    @Param("locationId") locationId: string,
    @Param("readerId") readerId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.terminal.removeReader(user.tenantId, locationId, readerId);
  }

  @Post("charge")
  @Roles("MANAGER", "TENANT_OWNER", "PLATFORM_ADMIN", "CASHIER")
  @ApiOperation({
    summary: "Charge an order to a card reader — the reader prompts the customer",
  })
  charge(
    @Body() body: { orderId: string; readerId: string },
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.terminal.chargeOrder({
      tenantId: user.tenantId,
      orderId: body.orderId,
      readerId: body.readerId,
    });
  }

  @Post("simulate-present")
  @Roles("MANAGER", "TENANT_OWNER", "PLATFORM_ADMIN", "CASHIER")
  @ApiOperation({ summary: "Test mode: simulate the customer tapping their card" })
  simulate(@Body() body: { readerId: string }) {
    return this.terminal.simulatePresent(body.readerId);
  }

  @Get("charge/status")
  @Roles("MANAGER", "TENANT_OWNER", "PLATFORM_ADMIN", "CASHIER")
  @ApiOperation({ summary: "Poll a terminal charge; settles the order when paid" })
  status(
    @Query("paymentIntentId") paymentIntentId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.terminal.status(user.tenantId, paymentIntentId);
  }
}
