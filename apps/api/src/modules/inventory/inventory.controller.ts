import {
  Controller,
  Get,
  Post,
  Patch,
  Put,
  Body,
  Param,
  Query,
  HttpCode,
  HttpStatus,
} from "@nestjs/common";
import { ApiTags, ApiOperation, ApiBearerAuth, ApiQuery } from "@nestjs/swagger";
import {
  InventoryService,
  CreateSupplierDto,
  UpdateSupplierDto,
  CreateIngredientDto,
  UpdateIngredientDto,
  AdjustStockDto,
  UpsertRecipeDto,
  CreatePurchaseOrderDto,
  ReceivePurchaseOrderDto,
  PurchaseOrderStatus,
} from "./inventory.service";
import { CurrentUser } from "../../common/decorators/current-user.decorator";
import { Roles } from "../../common/decorators/roles.decorator";
import { LocationAccessService } from "../../common/access/location-access.service";
import type { AuthenticatedUser } from "../auth/interfaces/jwt-payload.interface";

// Who may READ stock. Counting stock is shop-floor work, so this is the whole
// operating crew. Previously the read routes carried NO @Roles at all, which
// meant every authenticated user in the tenant could read them — including
// roles with no business seeing stock, like DRIVER or a KIOSK device.
const INVENTORY_VIEW = [
  "PLATFORM_ADMIN",
  "TENANT_OWNER",
  "OWNER",
  "DARK_KITCHEN_MANAGER",
  "MANAGER",
  "STAFF",
  "CASHIER",
  "KITCHEN_STAFF",
] as const;

// Who may CHANGE stock — adjust levels, raise and receive purchase orders.
// Same crew: a stock count is done by whoever is on shift.
//
// This list used to be ("MANAGER", "TENANT_OWNER") only, which predates the
// Team Roles generation — so OWNER and DARK_KITCHEN_MANAGER, the roles the
// Team Roles UI actually assigns, could not change stock at all. Same trap
// TILL_ROLES was created for.
const INVENTORY_MANAGE = INVENTORY_VIEW;

@ApiTags("inventory")
@ApiBearerAuth()
@Controller({ path: "inventory", version: "1" })
export class InventoryController {
  constructor(
    private readonly inventory: InventoryService,
    // Stock is per-location, and every route below takes the location from the
    // CLIENT. Without this the tenant check alone would let anyone on the crew
    // read or adjust any shop in the business by changing an id.
    private readonly access: LocationAccessService,
  ) {}

  // ── Suppliers ─────────────────────────────────────────────────────────────

  @Get("suppliers")
  @Roles(...INVENTORY_VIEW)
  @ApiOperation({ summary: "List all active suppliers for the tenant" })
  listSuppliers(@CurrentUser() user: AuthenticatedUser) {
    return this.inventory.listSuppliers(user.tenantId);
  }

  @Post("suppliers")
  @Roles(...INVENTORY_MANAGE)
  @ApiOperation({ summary: "Create a new supplier" })
  createSupplier(
    @Body() dto: CreateSupplierDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.inventory.createSupplier(user.tenantId, dto);
  }

  @Patch("suppliers/:id")
  @Roles(...INVENTORY_MANAGE)
  @ApiOperation({ summary: "Update an existing supplier" })
  updateSupplier(
    @Param("id") id: string,
    @Body() dto: UpdateSupplierDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.inventory.updateSupplier(id, user.tenantId, dto);
  }

  // ── Ingredients ───────────────────────────────────────────────────────────

  @Get("ingredients")
  @Roles(...INVENTORY_VIEW)
  @ApiOperation({ summary: "List ingredients for a location, optionally filtered to low stock" })
  @ApiQuery({ name: "locationId", required: true })
  @ApiQuery({ name: "lowStockOnly", required: false, type: Boolean })
  async listIngredients(
    @CurrentUser() user: AuthenticatedUser,
    @Query("locationId") locationId: string,
    @Query("lowStockOnly") lowStockOnly?: string,
  ) {
    await this.access.assertAccess(user, locationId);
    return this.inventory.listIngredients(user.tenantId, locationId, {
      lowStockOnly: lowStockOnly === "true",
    });
  }

  @Post("ingredients")
  @Roles(...INVENTORY_MANAGE)
  @ApiOperation({ summary: "Create a new ingredient" })
  async createIngredient(
    @Body() dto: CreateIngredientDto & { locationId: string },
    @CurrentUser() user: AuthenticatedUser,
  ) {
    const { locationId, ...rest } = dto;
    await this.access.assertAccess(user, locationId);
    return this.inventory.createIngredient(user.tenantId, locationId, rest);
  }

  @Patch("ingredients/:id")
  @Roles(...INVENTORY_MANAGE)
  @ApiOperation({ summary: "Update an ingredient" })
  async updateIngredient(
    @Param("id") id: string,
    @Body() dto: UpdateIngredientDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.inventory.updateIngredient(
      id,
      user.tenantId,
      dto,
      await this.access.scopeFilter(user),
    );
  }

  @Post("ingredients/:id/adjust")
  @Roles(...INVENTORY_MANAGE)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Adjust stock level for an ingredient (add, remove, correct)" })
  async adjustStock(
    @Param("id") id: string,
    @Body() dto: AdjustStockDto & { locationId: string },
    @CurrentUser() user: AuthenticatedUser,
  ) {
    const { locationId, ...rest } = dto;
    await this.access.assertAccess(user, locationId);
    return this.inventory.adjustStock(
      user.tenantId,
      locationId,
      id,
      rest,
      await this.access.scopeFilter(user),
    );
  }

  // ── Recipes ───────────────────────────────────────────────────────────────

  @Get("recipes/:menuItemId")
  @Roles(...INVENTORY_VIEW)
  @ApiOperation({ summary: "Get the recipe for a menu item" })
  getRecipe(
    @Param("menuItemId") menuItemId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.inventory.getRecipe(menuItemId, user.tenantId);
  }

  @Put("recipes/:menuItemId")
  @Roles(...INVENTORY_MANAGE)
  @ApiOperation({ summary: "Create or replace a menu item recipe" })
  upsertRecipe(
    @Param("menuItemId") menuItemId: string,
    @Body() dto: UpsertRecipeDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.inventory.upsertRecipe(menuItemId, user.tenantId, dto);
  }

  // ── Stock Alerts ──────────────────────────────────────────────────────────

  @Get("stock/low-alert")
  @Roles(...INVENTORY_VIEW)
  @ApiOperation({ summary: "Get all ingredients at or below their low-stock alert threshold" })
  @ApiQuery({ name: "locationId", required: true })
  async getLowStockAlert(
    @CurrentUser() user: AuthenticatedUser,
    @Query("locationId") locationId: string,
  ) {
    await this.access.assertAccess(user, locationId);
    return this.inventory.getLowStockIngredients(user.tenantId, locationId);
  }

  // ── Purchase Orders ───────────────────────────────────────────────────────

  @Get("purchase-orders")
  @Roles(...INVENTORY_VIEW)
  @ApiOperation({ summary: "List purchase orders for a location" })
  @ApiQuery({ name: "locationId", required: true })
  @ApiQuery({ name: "status", required: false, enum: PurchaseOrderStatus })
  async listPurchaseOrders(
    @CurrentUser() user: AuthenticatedUser,
    @Query("locationId") locationId: string,
    @Query("status") status?: PurchaseOrderStatus,
  ) {
    await this.access.assertAccess(user, locationId);
    return this.inventory.listPurchaseOrders(user.tenantId, locationId, status);
  }

  @Post("purchase-orders")
  @Roles(...INVENTORY_MANAGE)
  @ApiOperation({ summary: "Create a new purchase order (starts as DRAFT)" })
  async createPurchaseOrder(
    @Body() dto: CreatePurchaseOrderDto & { locationId: string },
    @CurrentUser() user: AuthenticatedUser,
  ) {
    const { locationId, ...rest } = dto;
    await this.access.assertAccess(user, locationId);
    return this.inventory.createPurchaseOrder(user.tenantId, locationId, rest);
  }

  @Post("purchase-orders/:id/submit")
  @Roles(...INVENTORY_MANAGE)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Submit a DRAFT purchase order to the supplier" })
  async submitPurchaseOrder(
    @Param("id") id: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.inventory.submitPurchaseOrder(
      id,
      user.tenantId,
      await this.access.scopeFilter(user),
    );
  }

  @Post("purchase-orders/:id/receive")
  @Roles(...INVENTORY_MANAGE)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Record received quantities for a purchase order" })
  async receivePurchaseOrder(
    @Param("id") id: string,
    @Body() dto: ReceivePurchaseOrderDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.inventory.receivePurchaseOrder(
      id,
      user.tenantId,
      dto,
      await this.access.scopeFilter(user),
    );
  }

  // ── Menu Availability Sync ────────────────────────────────────────────────

  @Post("sync")
  @Roles(...INVENTORY_MANAGE)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Sync menu item availability based on current stock levels" })
  @ApiQuery({ name: "locationId", required: true })
  async syncAvailability(
    @CurrentUser() user: AuthenticatedUser,
    @Query("locationId") locationId: string,
  ) {
    await this.access.assertAccess(user, locationId);
    return this.inventory.syncMenuItemAvailability(user.tenantId, locationId);
  }
}
