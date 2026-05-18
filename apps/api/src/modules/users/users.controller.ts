import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
  HttpCode,
  HttpStatus,
} from "@nestjs/common";
import { ApiTags, ApiOperation, ApiBearerAuth } from "@nestjs/swagger";
import { UsersService, InviteUserDto, AcceptInviteDto, UpdateUserRoleDto } from "./users.service";
import { CurrentUser } from "../../common/decorators/current-user.decorator";
import { Roles } from "../../common/decorators/roles.decorator";
import { Public } from "../../common/decorators/public.decorator";
import type { AuthenticatedUser } from "../auth/interfaces/jwt-payload.interface";

@ApiTags("users")
@ApiBearerAuth()
@Controller({ path: "users", version: "1" })
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @Get()
  @ApiOperation({ summary: "List all users in the tenant" })
  findAll(@CurrentUser() user: AuthenticatedUser) {
    return this.users.findAll(user.tenantId);
  }

  @Get(":userId")
  @ApiOperation({ summary: "Get user details" })
  findOne(
    @Param("userId") userId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.users.findOne(userId, user.tenantId);
  }

  @Post("invite")
  @Roles("MANAGER", "TENANT_OWNER", "PLATFORM_ADMIN")
  @ApiOperation({ summary: "Invite a new team member" })
  invite(
    @Body() dto: InviteUserDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.users.invite(user.tenantId, dto);
  }

  @Public()
  @Post("invite/accept")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Accept an invitation and set a password" })
  acceptInvite(@Body() dto: AcceptInviteDto) {
    return this.users.acceptInvite(dto);
  }

  @Patch(":userId/role")
  @Roles("MANAGER", "TENANT_OWNER", "PLATFORM_ADMIN")
  @ApiOperation({ summary: "Update a user's role" })
  updateRole(
    @Param("userId") userId: string,
    @Body() dto: UpdateUserRoleDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.users.updateRole(userId, user.tenantId, dto, user.role);
  }

  @Delete(":userId")
  @Roles("TENANT_OWNER", "PLATFORM_ADMIN")
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: "Deactivate a user and revoke all sessions" })
  deactivate(
    @Param("userId") userId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.users.deactivate(userId, user.tenantId);
  }
}
