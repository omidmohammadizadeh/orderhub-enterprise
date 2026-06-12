// Phase AP-AUTH — public customer auth routes.
//
// All routes are @Public() (opt out of staff JwtAuthGuard); the /me
// endpoint uses CustomerJwtGuard to identify the caller.

import {
  Body,
  Controller,
  Get,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
} from "@nestjs/common";
import type { Request, Response } from "express";
import { AuthGuard } from "@nestjs/passport";
import { ConfigService } from "@nestjs/config";
import { CustomerGoogleGuard } from "./customer-google.guard";
import { ApiTags, ApiOperation } from "@nestjs/swagger";
import { Public } from "../../common/decorators/public.decorator";
import { CustomerAuthService } from "./customer-auth.service";
import { CustomerSignupDto } from "./dto/signup.dto";
import { CustomerLoginDto } from "./dto/login.dto";
import { CustomerJwtGuard, CurrentCustomer } from "./customer.decorator";
import type { CustomerGoogleProfile } from "./customer-google.strategy";

@ApiTags("Customer Auth")
@Controller("customer-auth")
export class CustomerAuthController {
  constructor(
    private readonly customerAuth: CustomerAuthService,
    private readonly config: ConfigService,
  ) {}

  @Public()
  @Post("signup")
  @ApiOperation({ summary: "Customer email/password signup" })
  signup(@Body() dto: CustomerSignupDto) {
    return this.customerAuth.signup(dto);
  }

  @Public()
  @Get("verify")
  @ApiOperation({ summary: "Verify email via signed token link" })
  verify(@Query("token") token: string) {
    return this.customerAuth.verifyEmail(token);
  }

  @Public()
  @Post("login")
  @ApiOperation({ summary: "Customer email/password login" })
  login(@Body() dto: CustomerLoginDto) {
    return this.customerAuth.login(dto);
  }

  @UseGuards(CustomerJwtGuard)
  @Get("me")
  @ApiOperation({ summary: "Current customer (from JWT)" })
  me(@CurrentCustomer() customer: any) {
    return customer;
  }

  // ── Google OAuth ─────────────────────────────────────────────────
  //
  // Two-leg dance. Customer hits /google?storeSlug=X → Passport sends
  // them to Google. Google bounces them back to /google/callback with
  // an auth code. Passport's AuthGuard exchanges the code for a
  // profile, we upsert the CustomerAccount, then redirect the browser
  // to /order/{storeSlug}/auth/google-callback?token=<jwt> on the web
  // app. The web app stores the token and bounces to the storefront.

  @Public()
  @Get("google")
  @UseGuards(CustomerGoogleGuard)
  @ApiOperation({ summary: "Start Google OAuth (customer)" })
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  googleStart(@Query("storeSlug") _storeSlug?: string) {
    // Passport handles the redirect to Google. We never reach this
    // function body — the guard intercepts the response and 302s away.
    // The `state` parameter that carries storeSlug is set in the
    // guard's URL-building step via passport's default state handling.
    return;
  }

  @Public()
  @Get("google/callback")
  @UseGuards(CustomerGoogleGuard)
  @ApiOperation({ summary: "Google OAuth callback (customer)" })
  async googleCallback(
    @Req() req: Request,
    @Res() res: Response,
    @Query("state") state: string | undefined,
  ) {
    const profile = req.user as CustomerGoogleProfile;
    const { accessToken } = await this.customerAuth.createOrLinkGoogle(profile);

    // Build the storefront redirect. `state` was the storeSlug at
    // start; fall back to the marketing root if it's missing.
    const webUrl =
      this.config.get<string>("WEB_URL") ??
      "https://www.orderhubsolutions.com";
    const storeSlug = (state ?? "").trim();
    const target = storeSlug
      ? `${webUrl}/order/${encodeURIComponent(storeSlug)}/auth/google-callback?token=${encodeURIComponent(accessToken)}`
      : `${webUrl}/auth/google-callback?token=${encodeURIComponent(accessToken)}`;
    return res.redirect(target);
  }
}
