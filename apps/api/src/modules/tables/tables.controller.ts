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
import { TablesService } from "./tables.service";
import { CurrentUser } from "../../common/decorators/current-user.decorator";
import { Roles } from "../../common/decorators/roles.decorator";
import type { AuthenticatedUser } from "../auth/interfaces/jwt-payload.interface";

interface UpsertBody {
  locationId: string;
  name: string;
  seats?: number | null;
  area?: string | null;
  sortOrder?: number;
  isActive?: boolean;
}

// Table Tabs (dine-in). Layout CRUD is manager-tier; the operational actions
// (list / seat / free / link a tab's order) are open to front-of-house staff
// (CASHIER) too. Tenant scope comes from the verified JWT.
// Lists include BOTH legacy role names and the newer Team-Roles (OWNER, STAFF,
// DARK_KITCHEN_MANAGER) so every equivalent role can run table service.
const MANAGE = [
  "PLATFORM_ADMIN",
  "TENANT_OWNER",
  "OWNER",
  "MANAGER",
  "DARK_KITCHEN_MANAGER",
] as const;
const OPERATE = [...MANAGE, "CASHIER", "STAFF"] as const;

@ApiTags("tables")
@ApiBearerAuth()
@Controller({ path: "tables", version: "1" })
export class TablesController {
  constructor(private readonly tables: TablesService) {}

  @Get()
  @Roles(...OPERATE)
  @ApiOperation({ summary: "List tables (optionally by location)" })
  list(
    @CurrentUser() user: AuthenticatedUser,
    @Query("locationId") locationId?: string,
  ) {
    return this.tables.list(user.tenantId, locationId);
  }

  @Post()
  @Roles(...MANAGE)
  @ApiOperation({ summary: "Create a table" })
  create(@Body() body: UpsertBody, @CurrentUser() user: AuthenticatedUser) {
    return this.tables.create(user.tenantId, body);
  }

  @Patch(":id")
  @Roles(...MANAGE)
  @ApiOperation({ summary: "Update a table" })
  update(
    @Param("id") id: string,
    @Body() body: Partial<UpsertBody>,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.tables.update(user.tenantId, id, body);
  }

  @Delete(":id")
  @Roles(...MANAGE)
  @ApiOperation({ summary: "Delete a table" })
  remove(@Param("id") id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.tables.remove(user.tenantId, id);
  }

  @Post(":id/seat")
  @Roles(...OPERATE)
  @ApiOperation({ summary: "Seat a table (open its tab)" })
  seat(@Param("id") id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.tables.seat(user.tenantId, id);
  }

  @Post(":id/link-order")
  @Roles(...OPERATE)
  @ApiOperation({ summary: "Attach the tab's order to the table" })
  linkOrder(
    @Param("id") id: string,
    @Body() body: { orderId: string },
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.tables.linkOrder(user.tenantId, id, body.orderId);
  }

  @Post(":id/free")
  @Roles(...OPERATE)
  @ApiOperation({ summary: "Free a table after its tab is settled" })
  free(@Param("id") id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.tables.free(user.tenantId, id);
  }

  // ── Service essentials: move & merge ────────────────────────────────
  @Post(":id/move")
  @Roles(...OPERATE)
  @ApiOperation({ summary: "Move this table's tab to another (free) table" })
  move(
    @Param("id") id: string,
    @Body() body: { toTableId: string },
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.tables.moveTab(user.tenantId, id, body.toTableId);
  }

  @Post(":id/merge")
  @Roles(...OPERATE)
  @ApiOperation({ summary: "Merge this table's tab into another table's tab" })
  merge(
    @Param("id") id: string,
    @Body() body: { intoTableId: string },
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.tables.mergeTabs(user.tenantId, id, body.intoTableId);
  }
}
