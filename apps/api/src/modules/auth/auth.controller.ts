import {
  Controller,
  Post,
  Get,
  Body,
  Req,
  Res,
  HttpCode,
  HttpStatus,
  UseGuards,
  Delete,
  ServiceUnavailableException,
} from "@nestjs/common";
import { AuthGuard } from "@nestjs/passport";
import { ConfigService } from "@nestjs/config";
import { Response } from "express";
import { OAuthService } from "./services/oauth.service";
import { NativeOAuthService } from "./services/native-oauth.service";
import { TokenService } from "./services/token.service";
import { PrismaService } from "../../infrastructure/database/prisma.service";
import type { OAuthProfile } from "./interfaces/oauth-provider.interface";
import {
  ApiTags,
  ApiOperation,
  ApiBearerAuth,
  ApiResponse,
} from "@nestjs/swagger";
import { Request } from "express";
import { Throttle } from "@nestjs/throttler";
import { AuthService } from "./auth.service";
import { LoginDto } from "./dto/login.dto";
import { RefreshTokenDto } from "./dto/refresh-token.dto";
import {
  GoogleNativeAuthDto,
  AppleNativeAuthDto,
} from "./dto/native-oauth.dto";
import {
  LoginResponseDto,
  AuthTokensDto,
  UserProfileDto,
} from "./dto/auth-response.dto";
import { LocalAuthGuard } from "../../common/guards/local-auth.guard";
import { JwtAuthGuard } from "../../common/guards/jwt-auth.guard";
import { Public } from "../../common/decorators/public.decorator";
import { CurrentUser } from "../../common/decorators/current-user.decorator";
import { BillingExempt } from "../../common/guards/billing.guard";
import type { AuthenticatedUser } from "./interfaces/jwt-payload.interface";
import type { RequestMeta } from "./interfaces/request-meta.interface";

function extractMeta(req: Request): RequestMeta {
  return {
    ipAddress:
      (req.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim() ??
      req.socket.remoteAddress ??
      "unknown",
    userAgent: req.headers["user-agent"] ?? "unknown",
  };
}

@ApiTags("auth")
@BillingExempt() // Auth endpoints must always be accessible regardless of billing state
@Controller({ path: "auth", version: "1" })
export class AuthController {
  constructor(
    private readonly authService: AuthService,
    private readonly oauthService: OAuthService,
    private readonly nativeOAuth: NativeOAuthService,
    private readonly tokenService: TokenService,
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  /** True when Google OAuth env vars are configured. Routes return 503
   *  with a clear message when this is false instead of throwing inside
   *  passport-google-oauth20 (which prints an opaque internal error). */
  private googleConfigured(): boolean {
    return (
      !!this.config.get("GOOGLE_CLIENT_ID") &&
      !!this.config.get("GOOGLE_CLIENT_SECRET")
    );
  }

  // ── POST /api/v1/auth/login ───────────────────────────
  // Strict rate limit: 5 attempts per minute per IP to slow brute force.
  @Public()
  @UseGuards(LocalAuthGuard)
  @Post("login")
  @HttpCode(HttpStatus.OK)
  @Throttle({ login: { ttl: 60_000, limit: 5 } })
  @ApiOperation({ summary: "Login with email and password" })
  @ApiResponse({ status: 200, type: LoginResponseDto })
  @ApiResponse({ status: 401, description: "Invalid credentials" })
  async login(
    @Body() _dto: LoginDto, // DTO is here for Swagger + class-validator only;
    @Req() req: Request,    // LocalAuthGuard already ran validate() and put user on req
  ): Promise<LoginResponseDto> {
    return this.authService.login(
      req.user as AuthenticatedUser,
      extractMeta(req),
    );
  }

  // ── POST /api/v1/auth/refresh ─────────────────────────
  @Public()
  @Post("refresh")
  @HttpCode(HttpStatus.OK)
  @Throttle({ login: { ttl: 60_000, limit: 10 } })
  @ApiOperation({ summary: "Rotate refresh token and issue a new access token" })
  @ApiResponse({ status: 200, type: AuthTokensDto })
  @ApiResponse({ status: 401, description: "Invalid or expired refresh token" })
  async refresh(
    @Body() dto: RefreshTokenDto,
    @Req() req: Request,
  ): Promise<AuthTokensDto> {
    return this.authService.refresh(dto.refreshToken, extractMeta(req));
  }

  // ── POST /api/v1/auth/logout ──────────────────────────
  @UseGuards(JwtAuthGuard)
  @Post("logout")
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiBearerAuth()
  @ApiOperation({ summary: "Revoke current refresh token (logout)" })
  async logout(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: RefreshTokenDto,
    @Req() req: Request,
  ): Promise<void> {
    await this.authService.logout(user, dto.refreshToken, extractMeta(req));
  }

  // ── DELETE /api/v1/auth/sessions ──────────────────────
  @UseGuards(JwtAuthGuard)
  @Delete("sessions")
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiBearerAuth()
  @ApiOperation({ summary: "Revoke all sessions (logout all devices)" })
  async logoutAll(
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: Request,
  ): Promise<void> {
    await this.authService.logoutAll(user, extractMeta(req));
  }

  // ── GET /api/v1/auth/me ───────────────────────────────
  @UseGuards(JwtAuthGuard)
  @Get("me")
  @ApiBearerAuth()
  @ApiOperation({ summary: "Get the authenticated user profile" })
  @ApiResponse({ status: 200, type: UserProfileDto })
  async me(@CurrentUser() user: AuthenticatedUser): Promise<UserProfileDto> {
    return this.authService.getMe(user);
  }

  // ── Google OAuth ────────────────────────────────────────────────────────
  //
  // Two-step OAuth dance handled directly via passport-google-oauth20
  // (no Supabase middleman — that adds a hop and a second JWT format to
  // verify, with no extra security benefit for our use case):
  //
  //   1. Web app links to /api/v1/auth/oauth/google
  //   2. AuthGuard("google") redirects the browser to Google's consent page
  //   3. Google redirects back to /api/v1/auth/oauth/google/callback
  //   4. Same guard exchanges the auth code for a profile, hands it to
  //      OAuthService.findOrCreateUser, which either links to an existing
  //      user by email or creates a fresh one
  //   5. We sign our own JWT + refresh-token pair, then redirect to the
  //      web app at WEB_URL/auth/oauth/callback?access=…&refresh=…
  //      where the client persists them and routes into the dashboard
  //
  // Each route checks googleConfigured() first so missing env vars
  // surface as a clean 503 instead of an opaque Passport stack trace.

  @Public()
  @Get("oauth/google")
  @ApiOperation({ summary: "Initiate Google OAuth flow" })
  async googleLogin(@Req() req: Request, @Res() res: Response) {
    if (!this.googleConfigured()) {
      throw new ServiceUnavailableException(
        "Google sign-in is not configured. Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET on the API.",
      );
    }
    // Manually invoke the guard so we can return a clean 503 above.
    const guard = new (AuthGuard("google"))();
    // @ts-expect-error — guard.canActivate handles redirect side-effects
    return guard.canActivate({ switchToHttp: () => ({ getRequest: () => req, getResponse: () => res }) });
  }

  @Public()
  @UseGuards(AuthGuard("google"))
  @Get("oauth/google/callback")
  @ApiOperation({ summary: "Google OAuth callback" })
  async googleCallback(@Req() req: Request, @Res() res: Response) {
    const webUrl = (
      this.config.get<string>("WEB_URL") ?? "http://localhost:3000"
    ).replace(/\/+$/, "");

    const profile = req.user as OAuthProfile | undefined;
    if (!profile) {
      return res.redirect(`${webUrl}/auth/login?error=oauth_failed`);
    }

    try {
      // Pick a default tenant for brand-new Google users — first existing
      // tenant in the system. Multi-tenant onboarding (where each Google
      // sign-in spawns its own tenant) is a follow-up.
      const defaultTenant = await this.prisma.tenant.findFirst({
        orderBy: { createdAt: "asc" },
        select: { id: true },
      });
      if (!defaultTenant) {
        return res.redirect(`${webUrl}/auth/login?error=no_tenant`);
      }

      const { userId, tenantId } = await this.oauthService.findOrCreateUser(
        profile,
        defaultTenant.id,
      );

      const user = await this.prisma.user.findUniqueOrThrow({
        where: { id: userId },
        select: { id: true, role: true, permissions: true, isActive: true },
      });
      if (!user.isActive) {
        return res.redirect(`${webUrl}/auth/login?error=account_inactive`);
      }

      const tokens = await this.tokenService.generateTokenPair(
        {
          userId: user.id,
          tenantId,
          role: user.role,
          permissions: user.permissions,
        },
        extractMeta(req),
      );

      const params = new URLSearchParams({
        access: tokens.accessToken,
        refresh: tokens.refreshToken,
      });
      return res.redirect(`${webUrl}/auth/oauth/callback?${params.toString()}`);
    } catch (err: any) {
      return res.redirect(
        `${webUrl}/auth/login?error=${encodeURIComponent(err?.message ?? "oauth_failed")}`,
      );
    }
  }

  // ── Native mobile OAuth ─────────────────────────────────────────────
  //
  // The Expo mobile app uses native sign-in SDKs that produce a signed
  // ID token on-device. These two endpoints accept that token, verify it
  // against the provider, find-or-create the OrderHub user, and return
  // the same LoginResponseDto that /login produces. No browser round-trip.

  @Public()
  @Post("google/native")
  @HttpCode(HttpStatus.OK)
  @Throttle({ login: { ttl: 60_000, limit: 10 } })
  @ApiOperation({ summary: "Exchange a native Google ID token for an OrderHub JWT" })
  @ApiResponse({ status: 200, type: LoginResponseDto })
  @ApiResponse({ status: 401, description: "Invalid Google ID token" })
  async googleNative(
    @Body() dto: GoogleNativeAuthDto,
    @Req() req: Request,
  ): Promise<LoginResponseDto> {
    const profile = await this.nativeOAuth.verifyGoogleIdToken(dto.idToken);
    return this.exchangeNativeProfile(profile, req);
  }

  @Public()
  @Post("apple/native")
  @HttpCode(HttpStatus.OK)
  @Throttle({ login: { ttl: 60_000, limit: 10 } })
  @ApiOperation({ summary: "Exchange a native Apple ID token for an OrderHub JWT" })
  @ApiResponse({ status: 200, type: LoginResponseDto })
  @ApiResponse({ status: 401, description: "Invalid Apple ID token" })
  async appleNative(
    @Body() dto: AppleNativeAuthDto,
    @Req() req: Request,
  ): Promise<LoginResponseDto> {
    const profile = await this.nativeOAuth.verifyAppleIdToken(
      dto.idToken,
      dto.email,
      dto.fullName,
    );
    return this.exchangeNativeProfile(profile, req);
  }

  // Shared tail of both native flows — picks the default tenant, runs
  // findOrCreateUser, then issues an OrderHub JWT pair + user profile.
  private async exchangeNativeProfile(
    profile: OAuthProfile,
    req: Request,
  ): Promise<LoginResponseDto> {
    const defaultTenant = await this.prisma.tenant.findFirst({
      orderBy: { createdAt: "asc" },
      select: { id: true },
    });
    if (!defaultTenant) {
      throw new ServiceUnavailableException(
        "No tenant available — contact support",
      );
    }

    const { userId, tenantId } = await this.oauthService.findOrCreateUser(
      profile,
      defaultTenant.id,
    );

    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
    });
    if (!user.isActive) {
      throw new ServiceUnavailableException("Account is inactive");
    }

    const tokens = await this.tokenService.generateTokenPair(
      {
        userId: user.id,
        tenantId,
        role: user.role,
        permissions: user.permissions,
      },
      extractMeta(req),
    );

    return this.authService.buildLoginResponse(user, tokens, tenantId);
  }
}
