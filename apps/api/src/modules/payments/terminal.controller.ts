import {
  Controller,
  Get,
  Post,
  Delete,
  Body,
  Param,
  Query,
  ForbiddenException,
} from "@nestjs/common";
import { ApiTags, ApiOperation, ApiBearerAuth } from "@nestjs/swagger";
import { TerminalService } from "./terminal.service";
import { CurrentUser } from "../../common/decorators/current-user.decorator";
import { Roles, TILL_ROLES } from "../../common/decorators/roles.decorator";
import type { AuthenticatedUser } from "../auth/interfaces/jwt-payload.interface";

// Stripe Terminal (S700 / WisePOS E) — server-driven card-present payments.
//
// SIMULATED (test-drive) flows are PLATFORM_ADMIN-only, enforced server-side:
// a simulated charge settles an order as PAID without moving real money, so a
// restaurant operator must never be able to trigger one — not via the UI
// (testMode:false hides every simulate control) and not by calling the API
// with simulated:true directly.
@ApiTags("payments")
@ApiBearerAuth()
@Controller({ path: "payments/terminal", version: "1" })
export class TerminalController {
  constructor(private readonly terminal: TerminalService) {}

  private canSimulate(user: AuthenticatedUser): boolean {
    return this.terminal.isTestMode && user.role === "PLATFORM_ADMIN";
  }

  @Get("locations/:locationId/readers")
  @ApiOperation({ summary: "List card readers registered at a location" })
  async listReaders(
    @Param("locationId") locationId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    const data = await this.terminal.listReaders(user.tenantId, locationId);
    // testMode drives ALL simulate UI (WisePad checkbox + "Add simulated
    // reader"); only the platform admin ever sees it.
    return { ...data, testMode: this.canSimulate(user) };
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
    // "simulated-…" registration codes are the test drive — admin only.
    if (
      (body.registrationCode ?? "").includes("simulated") &&
      !this.canSimulate(user)
    ) {
      throw new ForbiddenException("Simulated readers are admin-only.");
    }
    return this.terminal.registerReader({
      tenantId: user.tenantId,
      locationId,
      registrationCode: body.registrationCode,
      label: body.label,
    });
  }

  @Post("locations/:locationId/readers/simulated")
  @Roles("PLATFORM_ADMIN")
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
  @Roles(...TILL_ROLES)
  @ApiOperation({
    summary: "Charge an order to a card reader — the reader prompts the customer",
  })
  charge(
    @Body() body: { orderId: string; readerId: string; amount?: number },
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.terminal.chargeOrder({
      tenantId: user.tenantId,
      orderId: body.orderId,
      readerId: body.readerId,
      // Present only for a split bill — charges this part, not the
      // whole order, and settlement holds the order open until the
      // parts cover the total.
      amount: body.amount,
    });
  }

  // ── SDK-driven mobile readers (BBPOS WisePad 3 / Tap to Pay) ──────────────

  @Post("connection-token")
  @Roles(...TILL_ROLES)
  @ApiOperation({
    summary:
      "Short-lived Stripe Terminal connection token for the on-device SDK (WisePad 3 / Tap to Pay)",
  })
  connectionToken(
    @Body() body: { locationId?: string; simulated?: boolean; orderId?: string },
    @CurrentUser() user: AuthenticatedUser,
  ) {
    // simulated only honoured for the platform admin — anyone else silently
    // gets a LIVE token, so a tampered client can't run test-mode charges.
    return this.terminal.createConnectionToken(
      user.tenantId,
      body?.locationId,
      body?.simulated === true && this.canSimulate(user),
      body?.orderId,
    );
  }

  @Post("charge/mobile")
  @Roles(...TILL_ROLES)
  @ApiOperation({
    summary:
      "Prepare an on-device card-present charge — returns a client secret the SDK collects + confirms on the reader",
  })
  chargeMobile(
    @Body() body: { orderId: string; simulated?: boolean },
    @CurrentUser() user: AuthenticatedUser,
  ) {
    // A simulated charge would settle the order PAID with no real money —
    // admin only. Anyone else gets a real (live-mode) charge.
    return this.terminal.createMobileCharge({
      tenantId: user.tenantId,
      orderId: body.orderId,
      simulated: body?.simulated === true && this.canSimulate(user),
    });
  }

  @Post("simulate-present")
  @Roles("PLATFORM_ADMIN")
  @ApiOperation({ summary: "Test mode: simulate the customer tapping their card" })
  simulate(@Body() body: { readerId: string }) {
    return this.terminal.simulatePresent(body.readerId);
  }

  @Get("charge/status")
  @Roles(...TILL_ROLES)
  @ApiOperation({ summary: "Poll a terminal charge; settles the order when paid" })
  status(
    @Query("paymentIntentId") paymentIntentId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.terminal.status(user.tenantId, paymentIntentId);
  }
}
