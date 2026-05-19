import {
  Controller,
  Post,
  Get,
  Body,
  Req,
  HttpCode,
  HttpStatus,
  UseGuards,
  Delete,
} from "@nestjs/common";
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
  constructor(private readonly authService: AuthService) {}

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

  // ── GET /api/v1/auth/oauth/google ─────────────────────
  // Redirects to Google consent page.
  // Guard is registered in AuthModule when Google credentials are present.
  // Stub routes here so Swagger documents the OAuth flow structure.
  @Public()
  @Get("oauth/google")
  @HttpCode(HttpStatus.FOUND)
  @ApiOperation({ summary: "Initiate Google OAuth flow" })
  // eslint-disable-next-line @typescript-eslint/no-empty-function
  async googleLogin() {}

  @Public()
  @Get("oauth/google/callback")
  @ApiOperation({ summary: "Google OAuth callback" })
  // eslint-disable-next-line @typescript-eslint/no-empty-function
  async googleCallback(@Req() _req: Request): Promise<void> {}
}
