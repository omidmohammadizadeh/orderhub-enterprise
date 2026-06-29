import { Body, Controller, Get, Post, Put, Query } from "@nestjs/common";
import { ApiTags, ApiOperation, ApiBearerAuth } from "@nestjs/swagger";
import { CurrentUser } from "../../common/decorators/current-user.decorator";
import { Roles } from "../../common/decorators/roles.decorator";
import type { AuthenticatedUser } from "../auth/interfaces/jwt-payload.interface";
import {
  WhatsAppConnectionService,
  WhatsAppConnectionDto,
} from "./whatsapp-connection.service";

// Phase AY (P6) — dashboard endpoints for per-location WhatsApp activation.
// Authenticated (no @Public, unlike the webhook controller).
@ApiTags("whatsapp")
@ApiBearerAuth()
@Controller({ path: "whatsapp/connection", version: "1" })
export class WhatsAppConnectionController {
  constructor(private readonly connection: WhatsAppConnectionService) {}

  @Get()
  @ApiOperation({ summary: "Get a location's WhatsApp connection" })
  get(
    @Query("locationId") locationId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.connection.getConnection(locationId, user.tenantId);
  }

  @Put()
  @Roles("MANAGER", "TENANT_OWNER", "PLATFORM_ADMIN")
  @ApiOperation({ summary: "Create / update a location's WhatsApp connection" })
  save(
    @Body() dto: WhatsAppConnectionDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.connection.saveConnection(user.tenantId, dto);
  }

  @Post("test")
  @Roles("MANAGER", "TENANT_OWNER", "PLATFORM_ADMIN")
  @ApiOperation({ summary: "Validate the saved number against Meta" })
  test(
    @Body() body: { locationId: string },
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.connection.testConnection(body.locationId, user.tenantId);
  }
}
