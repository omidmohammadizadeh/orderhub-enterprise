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
  getWallet(@CurrentUser() user: AuthenticatedUser) {
    return this.wallet.getSummary(user.tenantId);
  }

  // GET /v1/wallet/transactions — statement (top-ups + SMS debits).
  @Get("transactions")
  @Roles("PLATFORM_ADMIN", "TENANT_OWNER", "OWNER", "FINANCIAL_AGENT")
  @ApiOperation({ summary: "Wallet statement — top-ups and SMS debits" })
  getTransactions(
    @CurrentUser() user: AuthenticatedUser,
    @Query("limit") limit?: string,
  ) {
    return this.wallet.listTransactions(
      user.tenantId,
      limit ? parseInt(limit, 10) : 50,
    );
  }

  // POST /v1/wallet/topup — Stripe Checkout URL to add funds. amountMinor = pennies.
  @Post("topup")
  @Roles("PLATFORM_ADMIN", "TENANT_OWNER", "OWNER", "FINANCIAL_AGENT")
  @ApiOperation({ summary: "Start a wallet top-up (returns a Stripe Checkout URL)" })
  topup(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: { amountMinor?: number },
  ) {
    return this.wallet.startTopup(
      user.tenantId,
      Number(body?.amountMinor ?? 0),
      user.userId,
    );
  }
}
