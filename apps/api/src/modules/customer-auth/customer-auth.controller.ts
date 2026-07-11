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

  // @Public() bypasses the global staff JwtAuthGuard registered in
  // AppModule. Without it the staff strategy fires first, fails the
  // customer token's missing `type: "access"` claim, and 401s with
  // "Invalid token type" before our CustomerJwtGuard ever runs.
  // Sliding session: the storefront calls /me on every app load to
  // validate the stored token, so re-signing a fresh 90-day token here
  // means an actively-returning customer's "remembered" login never
  // actually expires — only real inactivity (90 days with no visit) does.
  // The frontend persists `accessToken` back over the one it sent.
  @Public()
  @UseGuards(CustomerJwtGuard)
  @Get("me")
  @ApiOperation({ summary: "Current customer (from JWT); returns a refreshed token" })
  async me(@CurrentCustomer() customer: any) {
    const accessToken = await this.customerAuth.signCustomerToken(customer);
    return { ...customer, accessToken };
  }

  // Phase AP-5 — customer's order history for the "My Orders" page.
  // Split into active (status not terminal) and history (last ~50
  // delivered/collected/cancelled). The page renders separate sections.
  @Public()
  @UseGuards(CustomerJwtGuard)
  @Get("orders")
  @ApiOperation({
    summary:
      "Current customer's orders, split active/history. Pass ?storeSlug= to scope to the storefront the customer is on (required for multi-shop privacy) and ?brandId= to further scope to a brand.",
  })
  myOrders(
    @CurrentCustomer() customer: any,
    @Query("brandId") brandId?: string,
    @Query("storeSlug") storeSlug?: string,
  ) {
    return this.customerAuth.listOrders(customer.id, { brandId, storeSlug });
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

    // `state` may be either the bare slug (legacy) or a pipe-joined
    // tuple "slug|origin" so we can land the customer back on the
    // exact origin they started from. Falling back to WEB_URL when
    // origin is absent.
    //
    // localStorage is origin-scoped: writing the token at
    // www.example.com and reading at example.com gives "Sign in"
    // forever. Threading the origin through OAuth state fixes that.
    const decodedState = decodeURIComponent((state ?? "").trim());
    const stateParts = decodedState.includes("|")
      ? decodedState.split("|")
      : [decodedState];
    const [rawSlug = "", rawOrigin = "", rawBrand = ""] = stateParts;
    const storeSlug = decodeURIComponent(rawSlug).trim();
    const candidateOrigin = decodeURIComponent(rawOrigin).trim();
    const brandId = decodeURIComponent(rawBrand).trim();

    // Tight allow-list — only accept origins we recognise to avoid
    // turning this into an open redirect.
    const ALLOWED_ORIGINS = new Set([
      "https://www.orderhubsolutions.com",
      "https://orderhubsolutions.com",
      "https://orderhub-web.onrender.com",
      "http://localhost:3000",
    ]);
    const safeOrigin = ALLOWED_ORIGINS.has(candidateOrigin)
      ? candidateOrigin
      : (this.config.get<string>("WEB_URL") ??
          "https://www.orderhubsolutions.com");

    const brandSuffix = brandId
      ? `&brand=${encodeURIComponent(brandId)}`
      : "";
    const target = storeSlug
      ? `${safeOrigin}/order/${encodeURIComponent(storeSlug)}/auth/google-callback?token=${encodeURIComponent(accessToken)}${brandSuffix}`
      : `${safeOrigin}/auth/google-callback?token=${encodeURIComponent(accessToken)}${brandSuffix}`;
    return res.redirect(target);
  }
}
