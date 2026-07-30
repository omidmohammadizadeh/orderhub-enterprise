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
import { KioskService, type KioskOrderItem } from "./kiosk.service";
import { CurrentUser } from "../../common/decorators/current-user.decorator";
import { Roles } from "../../common/decorators/roles.decorator";
import { Public } from "../../common/decorators/public.decorator";
import type { AuthenticatedUser } from "../auth/interfaces/jwt-payload.interface";

// Self-service kiosk. Registering a screen is a manager action; the screen
// itself is @Public() and keyed only by its rotatable token — there is no
// login on a device standing in a shop doorway.
const MANAGE = [
  "PLATFORM_ADMIN",
  "TENANT_OWNER",
  "OWNER",
  "MANAGER",
  "DARK_KITCHEN_MANAGER",
] as const;

@ApiTags("kiosk")
@Controller({ path: "kiosk", version: "1" })
export class KioskController {
  constructor(private readonly kiosk: KioskService) {}

  // ── Public device surface ───────────────────────────────────────────
  // Declared before the :id routes so "public" can never be read as an id.

  @Get("public/:token")
  @Public()
  @ApiOperation({ summary: "Resolve a kiosk screen by its token" })
  resolve(@Param("token") token: string) {
    return this.kiosk.resolve(token);
  }

  @Post("public/:token/order")
  @Public()
  @ApiOperation({ summary: "Place a walk-in order from a kiosk" })
  order(
    @Param("token") token: string,
    @Body()
    body: {
      items: KioskOrderItem[];
      payment: "CARD" | "PAY_AT_COUNTER";
      customerName?: string;
      notes?: string | null;
      requestId?: string;
    },
  ) {
    return this.kiosk.placeOrder(token, body);
  }

  // ── Staff CRUD ──────────────────────────────────────────────────────

  @Get()
  @ApiBearerAuth()
  @Roles(...MANAGE)
  @ApiOperation({ summary: "List kiosk screens" })
  list(
    @CurrentUser() user: AuthenticatedUser,
    @Query("locationId") locationId?: string,
  ) {
    return this.kiosk.list(user.tenantId, locationId);
  }

  @Post()
  @ApiBearerAuth()
  @Roles(...MANAGE)
  @ApiOperation({ summary: "Register a kiosk screen" })
  create(@Body() body: any, @CurrentUser() user: AuthenticatedUser) {
    return this.kiosk.create(user.tenantId, body);
  }

  @Patch(":id")
  @ApiBearerAuth()
  @Roles(...MANAGE)
  @ApiOperation({ summary: "Update a kiosk screen" })
  update(
    @Param("id") id: string,
    @Body() body: any,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.kiosk.update(user.tenantId, id, body);
  }

  @Post(":id/rotate-token")
  @ApiBearerAuth()
  @Roles(...MANAGE)
  @ApiOperation({ summary: "Issue a new token — the old URL stops working" })
  rotate(@Param("id") id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.kiosk.rotateToken(user.tenantId, id);
  }

  @Delete(":id")
  @ApiBearerAuth()
  @Roles(...MANAGE)
  @ApiOperation({ summary: "Delete a kiosk screen" })
  remove(@Param("id") id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.kiosk.remove(user.tenantId, id);
  }
}
