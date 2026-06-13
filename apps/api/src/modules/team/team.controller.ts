// Phase AR — Team Roles controller.
//
// All authenticated routes require the caller to be PLATFORM_ADMIN,
// TENANT_OWNER, OWNER (the new role name), or MANAGER. Accept-invite
// is public — the token is the auth.

import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Param,
  Post,
  Query,
} from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";
import {
  AcceptInviteDto,
  AssignRoleDto,
  InviteDto,
  TeamService,
  allowedGrantsForRole,
} from "./team.service";
import { CurrentUser } from "../../common/decorators/current-user.decorator";
import { Roles } from "../../common/decorators/roles.decorator";
import { Public } from "../../common/decorators/public.decorator";
import type { AuthenticatedUser } from "../auth/interfaces/jwt-payload.interface";

const MANAGE_TEAM_ROLES = [
  "PLATFORM_ADMIN",
  "TENANT_OWNER",
  "OWNER",
  "DARK_KITCHEN_MANAGER",
] as const;

@ApiTags("team")
@ApiBearerAuth()
@Controller({ path: "team", version: "1" })
export class TeamController {
  constructor(private readonly team: TeamService) {}

  // ── Members ────────────────────────────────────────────────────

  @Get("members")
  @Roles(...MANAGE_TEAM_ROLES)
  @ApiOperation({ summary: "List team members in this tenant" })
  listMembers(@CurrentUser() user: AuthenticatedUser) {
    return this.team.listMembers(user.tenantId, user.role as string);
  }

  @Get("grantable-roles")
  @Roles(...MANAGE_TEAM_ROLES)
  @ApiOperation({
    summary: "Roles the current caller is allowed to grant via assign/invite",
  })
  grantableRoles(@CurrentUser() user: AuthenticatedUser) {
    return { roles: allowedGrantsForRole(user.role as string) };
  }

  // ── User lookup for Assign Role ────────────────────────────────

  @Get("users/lookup")
  @Roles(...MANAGE_TEAM_ROLES)
  @ApiOperation({
    summary: "Lookup an existing user by email for the Assign Role flow",
  })
  async lookup(@Query("email") email: string) {
    if (!email) return { user: null };
    const user = await this.team.lookupByEmail(email);
    return { user };
  }

  @Delete("members/:userId")
  @HttpCode(HttpStatus.OK)
  @Roles(...MANAGE_TEAM_ROLES)
  @ApiOperation({ summary: "Remove a team member from this tenant" })
  removeMember(
    @CurrentUser() user: AuthenticatedUser,
    @Param("userId") userId: string,
  ) {
    return this.team.removeMember(
      user.tenantId,
      user.userId,
      userId,
      user.role as string,
    );
  }

  @Post("assign")
  @HttpCode(HttpStatus.OK)
  @Roles(...MANAGE_TEAM_ROLES)
  @ApiOperation({ summary: "Assign role + scope to an existing user" })
  assign(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: AssignRoleDto,
  ) {
    return this.team.assignRole(user.tenantId, dto, user.role as string);
  }

  // ── Invitations ────────────────────────────────────────────────

  @Get("invitations")
  @Roles(...MANAGE_TEAM_ROLES)
  @ApiOperation({ summary: "List pending invitations" })
  listInvitations(@CurrentUser() user: AuthenticatedUser) {
    return this.team.listInvitations(user.tenantId, user.role as string);
  }

  @Post("invitations")
  @Roles(...MANAGE_TEAM_ROLES)
  @ApiOperation({ summary: "Invite a new team member by email" })
  invite(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: InviteDto,
  ) {
    return this.team.createInvitation(
      user.tenantId,
      user.userId,
      dto,
      user.role as string,
    );
  }

  @Delete("invitations/:id")
  @Roles(...MANAGE_TEAM_ROLES)
  @ApiOperation({ summary: "Cancel a pending invitation" })
  cancelInvite(
    @CurrentUser() user: AuthenticatedUser,
    @Param("id") id: string,
  ) {
    return this.team.cancelInvitation(user.tenantId, id);
  }

  // ── Accept invitation (PUBLIC) ────────────────────────────────

  @Public()
  @Get("invitations/by-token/:token")
  @ApiOperation({ summary: "Fetch invitation details by token" })
  async getInviteByToken(@Param("token") token: string) {
    if (!token) throw new NotFoundException("Invitation not found");
    return this.team.getInvitationByToken(token);
  }

  @Public()
  @Post("invitations/by-token/:token/accept")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Accept an invitation and create the account" })
  acceptInvite(
    @Param("token") token: string,
    @Body() dto: AcceptInviteDto,
  ) {
    return this.team.acceptInvitation(token, dto);
  }
}
