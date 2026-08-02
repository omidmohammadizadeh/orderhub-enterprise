import { Body, Controller, Get, Post, Query } from "@nestjs/common";
import { ApiTags, ApiOperation, ApiBearerAuth } from "@nestjs/swagger";
import { WalletService } from "./wallet.service";
import { CurrentUser } from "../../common/decorators/current-user.decorator";
import { Roles } from "../../common/decorators/roles.decorator";
import type { AuthenticatedUser } from "../auth/interfaces/jwt-payload.interface";

@ApiTags("wallet")
@ApiBearerAuth()
@Controller({ path: "wallet", version: "1" })
export class WalletController {
  constructor(private readonly wallet: WalletService) {}

  // GET /v1/wallet — balance, rate, low-balance flag.
  @Get()
  @Roles("PLATFORM_ADMIN", "TENANT_OWNER", "OWNER", "FINANCIAL_AGENT")
  @ApiOperation({ summary: "SMS wallet summary (balance, per-segment price)" })
  async getWallet(
    @CurrentUser() user: AuthenticatedUser,
    @Query("locationId") locationId?: string,
  ) {
    await this.wallet.assertLocationAccess(
      user.tenantId,
      locationId ?? null,
      user.userId,
      user.role,
    );
    return this.wallet.getSummary(user.tenantId, locationId ?? null);
  }

  // GET /v1/wallet/transactions — statement (top-ups + SMS debits).
  @Get("transactions")
  @Roles("PLATFORM_ADMIN", "TENANT_OWNER", "OWNER", "FINANCIAL_AGENT")
  @ApiOperation({ summary: "Wallet statement — top-ups and SMS debits" })
  async getTransactions(
    @CurrentUser() user: AuthenticatedUser,
    @Query("limit") limit?: string,
    @Query("locationId") locationId?: string,
  ) {
    await this.wallet.assertLocationAccess(
      user.tenantId,
      locationId ?? null,
      user.userId,
      user.role,
    );
    return this.wallet.listTransactions(
      user.tenantId,
      locationId ?? null,
      limit ? parseInt(limit, 10) : 50,
    );
  }

  // POST /v1/wallet/topup — Stripe Checkout URL to add funds. amountMinor = pennies.
  @Post("topup")
  @Roles("PLATFORM_ADMIN", "TENANT_OWNER", "OWNER", "FINANCIAL_AGENT")
  @ApiOperation({ summary: "Start a wallet top-up (returns a Stripe Checkout URL)" })
  async topup(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: { amountMinor?: number; locationId?: string },
  ) {
    await this.wallet.assertLocationAccess(
      user.tenantId,
      body?.locationId ?? null,
      user.userId,
      user.role,
    );
    return this.wallet.startTopup(
      user.tenantId,
      Number(body?.amountMinor ?? 0),
      user.userId,
      body?.locationId ?? null,
    );
  }

  // POST /v1/wallet/auto-topup — keep the AI phone line funded without anyone
  // watching the balance. The card comes from a normal top-up (saved
  // off-session), so enabling this without one is refused rather than silently
  // doing nothing.
  @Post("auto-topup")
  @Roles("PLATFORM_ADMIN", "TENANT_OWNER", "OWNER", "FINANCIAL_AGENT")
  @ApiOperation({ summary: "Enable/configure automatic wallet top-up" })
  async setAutoTopup(
    @CurrentUser() user: AuthenticatedUser,
    @Body()
    body: {
      enabled?: boolean;
      thresholdMinor?: number;
      amountMinor?: number;
      locationId?: string;
    },
  ) {
    await this.wallet.assertLocationAccess(
      user.tenantId,
      body?.locationId ?? null,
      user.userId,
      user.role,
    );
    await this.wallet.setAutoTopup(user.tenantId, body?.locationId ?? null, {
      enabled: body?.enabled !== false,
      thresholdMinor: body?.thresholdMinor,
      amountMinor: body?.amountMinor,
    });
    return this.wallet.getSummary(user.tenantId, body?.locationId ?? null);
  }
}
