import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
  Query,
  HttpCode,
  HttpStatus,
} from "@nestjs/common";
import { ApiTags, ApiOperation, ApiBearerAuth } from "@nestjs/swagger";
import { KdsService, CreateKdsScreenDto, UpdateKdsScreenDto } from "./kds.service";
import { CurrentUser } from "../../common/decorators/current-user.decorator";
import { Roles } from "../../common/decorators/roles.decorator";
import { BillingExempt } from "../../common/guards/billing.guard";
import type { AuthenticatedUser } from "../auth/interfaces/jwt-payload.interface";

@ApiTags("kds")
@ApiBearerAuth()
@BillingExempt() // Live kitchen display operations must never be blocked by billing
@Controller({ path: "kds", version: "1" })
export class KdsController {
  constructor(private readonly kds: KdsService) {}

  // ── Screens ───────────────────────────────────────────────────────────────

  @Get("screens")
  @ApiOperation({ summary: "List KDS screens for a location" })
  findScreens(
    @Query("locationId") locationId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.kds.findScreensByLocation(locationId, user.tenantId);
  }

  @Post("screens")
  @Roles("MANAGER", "TENANT_OWNER", "PLATFORM_ADMIN")
  @ApiOperation({ summary: "Create a KDS screen" })
  createScreen(
    @Query("locationId") locationId: string,
    @Body() dto: CreateKdsScreenDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.kds.createScreen(locationId, user.tenantId, dto);
  }

  @Patch("screens/:screenId")
  @Roles("MANAGER", "TENANT_OWNER", "PLATFORM_ADMIN")
  @ApiOperation({ summary: "Update a KDS screen" })
  updateScreen(
    @Param("screenId") screenId: string,
    @Body() dto: UpdateKdsScreenDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.kds.updateScreen(screenId, user.tenantId, dto);
  }

  @Delete("screens/:screenId")
  @Roles("MANAGER", "TENANT_OWNER", "PLATFORM_ADMIN")
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: "Remove a KDS screen" })
  removeScreen(
    @Param("screenId") screenId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.kds.removeScreen(screenId, user.tenantId);
  }

  @Get("screens/:screenId")
  @ApiOperation({ summary: "Get one KDS screen (settings for the display)" })
  getScreen(
    @Param("screenId") screenId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.kds.getScreen(screenId, user.tenantId);
  }

  @Get("screens/:screenId/stats")
  @ApiOperation({ summary: "Today's speed-of-service stats for a screen" })
  getStats(
    @Param("screenId") screenId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.kds.getStats(screenId, user.tenantId);
  }

  @Get("screens/:screenId/bumped")
  @ApiOperation({ summary: "Recently bumped tickets (recall rail)" })
  getBumped(
    @Param("screenId") screenId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.kds.getRecentBumped(screenId, user.tenantId);
  }

  // ── Tickets ───────────────────────────────────────────────────────────────

  @Get("screens/:screenId/tickets")
  @ApiOperation({ summary: "Get active tickets for a screen" })
  getTickets(
    @Param("screenId") screenId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.kds.getActiveTickets(screenId, user.tenantId);
  }

  @Post("screens/:screenId/tickets/:orderId/bump")
  @Roles(
    "KITCHEN_DISPLAY",
    "KITCHEN_STAFF",
    "CASHIER",
    "MANAGER",
    "TENANT_OWNER",
    "PLATFORM_ADMIN",
  )
  @ApiOperation({ summary: "Bump (complete) a ticket" })
  bumpTicket(
    @Param("screenId") screenId: string,
    @Param("orderId") orderId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.kds.bumpTicket(screenId, orderId, user.tenantId);
  }

  @Post("screens/:screenId/tickets/:orderId/items/:orderItemId/state")
  @Roles(
    "KITCHEN_DISPLAY",
    "KITCHEN_STAFF",
    "CASHIER",
    "MANAGER",
    "TENANT_OWNER",
    "PLATFORM_ADMIN",
  )
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Mark an item line cooked / not cooked on a ticket" })
  setItemState(
    @Param("screenId") screenId: string,
    @Param("orderId") orderId: string,
    @Param("orderItemId") orderItemId: string,
    @Body() body: { done: boolean; modifierIndex?: number },
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.kds.setItemState(
      screenId,
      orderId,
      orderItemId,
      !!body?.done,
      user.tenantId,
      body?.modifierIndex,
    );
  }

  @Post("screens/:screenId/tickets/:orderId/recall")
  @Roles(
    "KITCHEN_DISPLAY",
    "KITCHEN_STAFF",
    "CASHIER",
    "MANAGER",
    "TENANT_OWNER",
    "PLATFORM_ADMIN",
  )
  @ApiOperation({ summary: "Recall a bumped ticket" })
  recallTicket(
    @Param("screenId") screenId: string,
    @Param("orderId") orderId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.kds.recallTicket(screenId, orderId, user.tenantId);
  }
}
