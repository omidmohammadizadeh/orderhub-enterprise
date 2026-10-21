import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Logger,
  Param,
  Post,
  Query,
  Res,
} from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";
import { Response } from "express";
import { CurrentUser } from "../../../common/decorators/current-user.decorator";
import { Public } from "../../../common/decorators/public.decorator";
import { Roles } from "../../../common/decorators/roles.decorator";
import type { AuthenticatedUser } from "../../auth/interfaces/jwt-payload.interface";
import { MollieService } from "./mollie.service";

/**
 * Mollie Connect: onboarding a brand, switching it on, and Mollie's webhook.
 *
 * Onboarding routes are for the same people who can start a brand's Stripe or
 * Tap onboarding. None of them can move money by themselves — a payment only
 * goes to a Mollie account the restaurant itself approved on Mollie's pages.
 */
@ApiTags("payments")
@ApiBearerAuth()
@Controller({ path: "payments/mollie", version: "1" })
export class MollieController {
  private readonly logger = new Logger(MollieController.name);

  constructor(private readonly mollie: MollieService) {}

  @Get("status")
  @Roles("TENANT_OWNER", "FINANCIAL_AGENT")
  @ApiOperation({ summary: "Mollie state of every brand" })
  status(@CurrentUser() user: AuthenticatedUser) {
    return this.mollie.listStatus(user.tenantId);
  }

  @Post("brands/:brandId/connect")
  @Roles("TENANT_OWNER", "FINANCIAL_AGENT")
  @ApiOperation({ summary: "Consent URL for a restaurant that already has Mollie" })
  connect(@Param("brandId") brandId: string, @CurrentUser() user: AuthenticatedUser) {
    return this.mollie.connectUrl(user.tenantId, brandId);
  }

  @Post("brands/:brandId/client-link")
  @Roles("TENANT_OWNER", "FINANCIAL_AGENT")
  @ApiOperation({ summary: "Create a pre-filled Mollie sign-up link (Client Links API)" })
  clientLink(
    @Param("brandId") brandId: string,
    @Body() body: any,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.mollie.createClientLink(user.tenantId, brandId, body ?? {});
  }

  @Post("brands/:brandId/refresh")
  @Roles("TENANT_OWNER", "FINANCIAL_AGENT")
  @ApiOperation({ summary: "Re-read onboarding status and website profile from Mollie" })
  refresh(@Param("brandId") brandId: string, @CurrentUser() user: AuthenticatedUser) {
    return this.mollie.refreshStatus(user.tenantId, brandId);
  }

  @Post("brands/:brandId/enabled")
  @Roles("TENANT_OWNER", "FINANCIAL_AGENT")
  @ApiOperation({ summary: "Take this brand's online payments through Mollie (or back to Stripe)" })
  setEnabled(
    @Param("brandId") brandId: string,
    @Body() body: { enabled?: boolean },
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.mollie.setEnabled(user.tenantId, brandId, body?.enabled === true);
  }

  @Post("brands/:brandId/disconnect")
  @Roles("TENANT_OWNER", "FINANCIAL_AGENT")
  @ApiOperation({ summary: "Forget this brand's Mollie connection" })
  disconnect(@Param("brandId") brandId: string, @CurrentUser() user: AuthenticatedUser) {
    return this.mollie.disconnect(user.tenantId, brandId);
  }

  /**
   * GET /v1/payments/mollie/oauth/callback — where Mollie sends the browser
   * after consent (both "Connect" and client-link sign-ups). Public: the
   * browser arrives with no session. The signed `state` is what ties it to a
   * tenant's brand.
   */
  @Get("oauth/callback")
  @Public()
  async oauthCallback(
    @Query() q: { code?: string; state?: string; error?: string; error_description?: string },
    @Res() res: Response,
  ) {
    const to = await this.mollie.handleOAuthCallback(q ?? {});
    return res.redirect(302, to);
  }

  /**
   * POST /v1/payments/mollie/webhook — form body `id=tr_…`, no signature.
   * Always 200: Mollie retries anything else, and an id we can't match won't
   * match on the tenth try either. See MollieService.handleWebhook for why an
   * unsigned body is safe here.
   */
  @Post("webhook")
  @Public()
  @HttpCode(HttpStatus.OK)
  async webhook(@Body() body: { id?: string }) {
    await this.mollie
      .handleWebhook(body?.id)
      .catch((err: any) => this.logger.error(`Mollie webhook ${body?.id} failed: ${err?.message}`));
    return "";
  }
}
