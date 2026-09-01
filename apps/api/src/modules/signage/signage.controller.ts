import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
} from "@nestjs/common";
import { ApiTags, ApiOperation, ApiBearerAuth } from "@nestjs/swagger";
import { SignageService, type SignageConfig } from "./signage.service";
import { CurrentUser } from "../../common/decorators/current-user.decorator";
import { Roles } from "../../common/decorators/roles.decorator";
import { Public } from "../../common/decorators/public.decorator";
import type { AuthenticatedUser } from "../auth/interfaces/jwt-payload.interface";

interface UpsertBody {
  locationId: string;
  brandId?: string | null;
  name: string;
  categoryIds?: string[];
  orientation?: "landscape" | "portrait";
  config?: SignageConfig;
  isActive?: boolean;
}

// Digital Signage — menu boards on TV screens.
// CRUD is tenant-scoped (tenantId from the verified JWT). The TV render route
// is @Public() and looked up by an unguessable token — no login on the screen.
// Who may set up a shop's screens.
//
// Same trap as the locations controller: only the legacy role names were
// listed, so an owner or a dark-kitchen manager could not create a screen for
// their own shop and it looked like an admin-only feature.
const SIGNAGE_WRITE = [
  "PLATFORM_ADMIN",
  "TENANT_OWNER",
  "OWNER",
  "MANAGER",
  "DARK_KITCHEN_MANAGER",
] as const;

@ApiTags("signage")
@Controller({ path: "signage", version: "1" })
export class SignageController {
  constructor(private readonly signage: SignageService) {}

  @Get()
  @ApiBearerAuth()
  @Roles(...SIGNAGE_WRITE)
  @ApiOperation({ summary: "List signage displays (optionally by location)" })
  list(
    @CurrentUser() user: AuthenticatedUser,
    @Query("locationId") locationId?: string,
  ) {
    return this.signage.list(user.tenantId, locationId);
  }

  @Post()
  @ApiBearerAuth()
  @Roles(...SIGNAGE_WRITE)
  @ApiOperation({ summary: "Create a signage display" })
  create(@Body() body: UpsertBody, @CurrentUser() user: AuthenticatedUser) {
    return this.signage.create(user.tenantId, body);
  }

  @Patch(":id")
  @ApiBearerAuth()
  @Roles(...SIGNAGE_WRITE)
  @ApiOperation({ summary: "Update a signage display" })
  update(
    @Param("id") id: string,
    @Body() body: Partial<UpsertBody>,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.signage.update(user.tenantId, id, body);
  }

  @Delete(":id")
  @ApiBearerAuth()
  @Roles(...SIGNAGE_WRITE)
  @ApiOperation({ summary: "Delete a signage display" })
  remove(@Param("id") id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.signage.remove(user.tenantId, id);
  }

  // ── Public: the TV opens this by its unguessable token, no login ──────────
  @Get("public/:token")
  @Public()
  @ApiOperation({ summary: "Render a signage board for a TV (public, by token)" })
  renderPublic(@Param("token") token: string) {
    return this.signage.renderPublic(token);
  }
}
