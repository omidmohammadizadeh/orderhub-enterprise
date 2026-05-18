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
import type { AuthenticatedUser } from "../auth/interfaces/jwt-payload.interface";

@ApiTags("inventory")
@ApiBearerAuth()
@Controller({ path: "inventory", version: "1" })
export class InventoryController {
  constructor(private readonly inventory: InventoryService) {}

  // ── Suppliers ─────────────────────────────────────────────────────────────

  @Get("suppliers")
  @ApiOperation({ summary: "List all active suppliers for the tenant" })
  listSuppliers(@CurrentUser() user: AuthenticatedUser) {
    return this.inventory.listSuppliers(user.tenantId);
  }

  @Post("suppliers")
  @Roles("MANAGER", "TENANT_OWNER")
  @ApiOperation({ summary: "Create a new supplier" })
  createSupplier(
    @Body() dto: CreateSupplierDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.inventory.createSupplier(user.tenantId, dto);
  }

  @Patch("suppliers/:id")
  @Roles("MANAGER", "TENANT_OWNER")
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
  @ApiOperation({ summary: "List ingredients for a location, optionally filtered to low stock" })
  @ApiQuery({ name: "locationId", required: true })
  @ApiQuery({ name: "lowStockOnly", required: false, type: Boolean })
  listIngredients(
    @CurrentUser() user: AuthenticatedUser,
    @Query("locationId") locationId: string,
    @Query("lowStockOnly") lowStockOnly?: string,
  ) {
    return this.inventory.listIngredients(user.tenantId, locationId, {
      lowStockOnly: lowStockOnly === "true",
    });
  }

  @Post("ingredients")
  @Roles("MANAGER", "TENANT_OWNER")
  @ApiOperation({ summary: "Create a new ingredient" })
  createIngredient(
    @Body() dto: CreateIngredientDto & { locationId: string },
    @CurrentUser() user: AuthenticatedUser,
  ) {
    const { locationId, ...rest } = dto;
    return this.inventory.createIngredient(user.tenantId, locationId, rest);
  }

  @Patch("ingredients/:id")
  @Roles("MANAGER", "TENANT_OWNER")
  @ApiOperation({ summary: "Update an ingredient" })
  updateIngredient(
    @Param("id") id: string,
    @Body() dto: UpdateIngredientDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.inventory.updateIngredient(id, user.tenantId, dto);
  }

  @Post("ingredients/:id/adjust")
  @Roles("MANAGER", "TENANT_OWNER")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Adjust stock level for an ingredient (add, remove, correct)" })
  adjustStock(
    @Param("id") id: string,
    @Body() dto: AdjustStockDto & { locationId: string },
    @CurrentUser() user: AuthenticatedUser,
  ) {
    const { locationId, ...rest } = dto;
    return this.inventory.adjustStock(user.tenantId, locationId, id, rest);
  }

  // ── Recipes ───────────────────────────────────────────────────────────────

  @Get("recipes/:menuItemId")
  @ApiOperation({ summary: "Get the recipe for a menu item" })
  getRecipe(
    @Param("menuItemId") menuItemId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.inventory.getRecipe(menuItemId, user.tenantId);
  }

  @Put("recipes/:menuItemId")
  @Roles("MANAGER", "TENANT_OWNER")
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
  @ApiOperation({ summary: "Get all ingredients at or below their low-stock alert threshold" })
  @ApiQuery({ name: "locationId", required: true })
  getLowStockAlert(
    @CurrentUser() user: AuthenticatedUser,
    @Query("locationId") locationId: string,
  ) {
    return this.inventory.getLowStockIngredients(user.tenantId, locationId);
  }

  // ── Purchase Orders ───────────────────────────────────────────────────────

  @Get("purchase-orders")
  @ApiOperation({ summary: "List purchase orders for a location" })
  @ApiQuery({ name: "locationId", required: true })
  @ApiQuery({ name: "status", required: false, enum: PurchaseOrderStatus })
  listPurchaseOrders(
    @CurrentUser() user: AuthenticatedUser,
    @Query("locationId") locationId: string,
    @Query("status") status?: PurchaseOrderStatus,
  ) {
    return this.inventory.listPurchaseOrders(user.tenantId, locationId, status);
  }

  @Post("purchase-orders")
  @Roles("MANAGER", "TENANT_OWNER")
  @ApiOperation({ summary: "Create a new purchase order (starts as DRAFT)" })
  createPurchaseOrder(
    @Body() dto: CreatePurchaseOrderDto & { locationId: string },
    @CurrentUser() user: AuthenticatedUser,
  ) {
    const { locationId, ...rest } = dto;
    return this.inventory.createPurchaseOrder(user.tenantId, locationId, rest);
  }

  @Post("purchase-orders/:id/submit")
  @Roles("MANAGER", "TENANT_OWNER")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Submit a DRAFT purchase order to the supplier" })
  submitPurchaseOrder(
    @Param("id") id: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.inventory.submitPurchaseOrder(id, user.tenantId);
  }

  @Post("purchase-orders/:id/receive")
  @Roles("MANAGER", "TENANT_OWNER")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Record received quantities for a purchase order" })
  receivePurchaseOrder(
    @Param("id") id: string,
    @Body() dto: ReceivePurchaseOrderDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.inventory.receivePurchaseOrder(id, user.tenantId, dto);
  }

  // ── Menu Availability Sync ────────────────────────────────────────────────

  @Post("sync")
  @Roles("MANAGER", "TENANT_OWNER")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Sync menu item availability based on current stock levels" })
  @ApiQuery({ name: "locationId", required: true })
  syncAvailability(
    @CurrentUser() user: AuthenticatedUser,
    @Query("locationId") locationId: string,
  ) {
    return this.inventory.syncMenuItemAvailability(user.tenantId, locationId);
  }
}
