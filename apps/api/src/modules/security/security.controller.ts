import {
  Controller,
  Get,
  Post,
  Delete,
  Patch,
  Body,
  Param,
  Query,
  HttpCode,
  HttpStatus,
  Request,
} from "@nestjs/common";
import { ApiTags, ApiOperation, ApiBearerAuth } from "@nestjs/swagger";
import { SecurityService, AddIpRuleDto } from "./security.service";
import { CurrentUser } from "../../common/decorators/current-user.decorator";
import { Roles } from "../../common/decorators/roles.decorator";
import type { AuthenticatedUser } from "../auth/interfaces/jwt-payload.interface";

@ApiTags("security")
@ApiBearerAuth()
@Controller({ path: "security", version: "1" })
export class SecurityController {
  constructor(private readonly security: SecurityService) {}

  // ── MFA ─────────────────────────────────────────────────────────────────────

  // GET /v1/security/mfa/status
  @Get("mfa/status")
  @ApiOperation({ summary: "Get MFA status for current user" })
  getMfaStatus(@CurrentUser() user: AuthenticatedUser) {
    return this.security.getMfaStatus(user.userId);
  }

  // POST /v1/security/mfa/setup
  @Post("mfa/setup")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Generate MFA secret and QR code URL" })
  setupMfa(@CurrentUser() user: AuthenticatedUser) {
    return this.security.setupMfa(user.userId);
  }

  // POST /v1/security/mfa/verify
  @Post("mfa/verify")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Verify TOTP token and enable MFA" })
  verifyMfa(
    @Body() body: { token: string },
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.security.verifyAndEnableMfa(user.userId, body.token);
  }

  // DELETE /v1/security/mfa
  @Delete("mfa")
  @Roles("TENANT_OWNER")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Disable MFA for current user (TENANT_OWNER)" })
  disableMfa(
    @Body() body: { userId?: string },
    @CurrentUser() user: AuthenticatedUser,
  ) {
    // TENANT_OWNER can disable MFA for themselves or another user in their tenant
    const targetUserId = body.userId ?? user.userId;
    return this.security.disableMfa(targetUserId, user.tenantId);
  }

  // ── IP Allowlist ───────────────────────────────────────────────────────────

  // GET /v1/security/ip-allowlist
  @Get("ip-allowlist")
  @Roles("MANAGER", "TENANT_OWNER")
  @ApiOperation({ summary: "List IP allowlist rules (MANAGER+)" })
  getIpAllowlist(@CurrentUser() user: AuthenticatedUser) {
    return this.security.getIpAllowlist(user.tenantId);
  }

  // POST /v1/security/ip-allowlist
  @Post("ip-allowlist")
  @Roles("TENANT_OWNER")
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: "Add IP allowlist rule (TENANT_OWNER)" })
  addIpRule(
    @Body() dto: AddIpRuleDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.security.addIpRule(user.tenantId, dto);
  }

  // DELETE /v1/security/ip-allowlist/:id
  @Delete("ip-allowlist/:id")
  @Roles("TENANT_OWNER")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Remove IP allowlist rule (TENANT_OWNER)" })
  removeIpRule(
    @Param("id") id: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.security.removeIpRule(id, user.tenantId);
  }

  // PATCH /v1/security/ip-allowlist/:id/toggle
  @Patch("ip-allowlist/:id/toggle")
  @Roles("TENANT_OWNER")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Toggle IP allowlist rule active state (TENANT_OWNER)" })
  toggleIpRule(
    @Param("id") id: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.security.toggleIpRule(id, user.tenantId);
  }

  // ── Device Sessions ────────────────────────────────────────────────────────

  // GET /v1/security/sessions
  @Get("sessions")
  @ApiOperation({ summary: "List active device sessions for current user" })
  listSessions(@CurrentUser() user: AuthenticatedUser) {
    return this.security.listSessions(user.userId, user.tenantId);
  }

  // DELETE /v1/security/sessions/:id
  @Delete("sessions/:id")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Revoke a specific device session" })
  revokeSession(
    @Param("id") id: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.security.revokeSession(id, user.userId);
  }

  // DELETE /v1/security/sessions
  @Delete("sessions")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Revoke all sessions (keeps current session if token provided)" })
  revokeAllSessions(
    @Body() body: { exceptToken?: string },
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.security.revokeAllSessions(user.userId, user.tenantId, body.exceptToken);
  }

  // ── Audit Log ──────────────────────────────────────────────────────────────

  // GET /v1/security/audit-log
  @Get("audit-log")
  @Roles("TENANT_OWNER")
  @ApiOperation({ summary: "Get paginated audit log (TENANT_OWNER)" })
  getAuditLog(
    @CurrentUser() user: AuthenticatedUser,
    @Query("resource") resource?: string,
    @Query("userId") userId?: string,
    @Query("startDate") startDate?: string,
    @Query("endDate") endDate?: string,
    @Query("limit") limit?: string,
    @Query("offset") offset?: string,
  ) {
    return this.security.getAuditLog(user.tenantId, {
      resource,
      userId,
      startDate,
      endDate,
      limit: limit ? parseInt(limit, 10) : 50,
      offset: offset ? parseInt(offset, 10) : 0,
    });
  }
}
