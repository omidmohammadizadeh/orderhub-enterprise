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
  ParseUUIDPipe,
} from "@nestjs/common";
import { ApiTags, ApiOperation, ApiBearerAuth, ApiQuery } from "@nestjs/swagger";
import { MenusService } from "./menus.service";
import { PluService } from "./plu.service";
import { UberMenuImporter } from "./importers/uber-menu.importer";
import { DeliverooMenuImporter } from "./importers/deliveroo-menu.importer";
import { HubRiseCatalogService } from "../integrations/hubrise/hubrise-catalog.service";
import {
  CreateMenuDto,
  UpdateMenuDto,
  CreateCategoryDto,
  UpdateCategoryDto,
  CreateMenuItemDto,
  UpdateMenuItemDto,
  AddItemToCategoryDto,
  ReorderDto,
} from "./dto/menu.dto";
import { CurrentUser } from "../../common/decorators/current-user.decorator";
import { Roles } from "../../common/decorators/roles.decorator";
import type { AuthenticatedUser } from "../auth/interfaces/jwt-payload.interface";

@ApiTags("menus")
@ApiBearerAuth()
@Controller({ version: "1" })
export class MenusController {
  constructor(
    private readonly menus: MenusService,
    private readonly plu: PluService,
    private readonly uberImporter: UberMenuImporter,
    private readonly deliverooImporter: DeliverooMenuImporter,
    private readonly hubriseCatalog: HubRiseCatalogService,
  ) {}

  // ── Phase AK — PLU + Imports ──────────────────────────────────────────────

  @Post("menus/generate-missing-plus")
  @Roles("MANAGER", "TENANT_OWNER", "PLATFORM_ADMIN")
  @ApiOperation({
    summary: "Generate PLUs for any product/group/option that's missing one",
  })
  generateMissingPlus(@CurrentUser() user: AuthenticatedUser) {
    return this.plu.generateMissingForTenant(user.tenantId);
  }

  @Post("menus/:menuId/import/uber")
  @Roles("MANAGER", "TENANT_OWNER", "PLATFORM_ADMIN")
  @ApiOperation({ summary: "Import Uber Eats menu into the selected menu" })
  importUber(
    @Param("menuId") menuId: string,
    @Body() body: { payload?: any; storeId?: string; accessToken?: string },
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.uberImporter.import({
      menuId,
      tenantId: user.tenantId,
      payload: body.payload,
      storeId: body.storeId,
      accessToken: body.accessToken,
    });
  }

  // ── Phase AW-11 — HubRise catalog import + publish ────────────────────

  @Post("brands/:brandId/menus/import/hubrise")
  @Roles("MANAGER", "TENANT_OWNER", "PLATFORM_ADMIN")
  @ApiOperation({
    summary:
      "Import the location's HubRise catalog into a new (or existing) menu under this brand",
  })
  importHubRise(
    @Param("brandId") brandId: string,
    @Body() body: { locationId: string; catalogId?: string },
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.hubriseCatalog.importToMenu({
      tenantId: user.tenantId,
      brandId,
      locationId: body.locationId,
      catalogId: body.catalogId,
    });
  }

  @Post("menus/:menuId/publish/hubrise")
  @Roles("MANAGER", "TENANT_OWNER", "PLATFORM_ADMIN")
  @ApiOperation({
    summary:
      "Push this menu to HubRise as a catalog. Overwrites the location's existing catalog when one is already configured.",
  })
  publishHubRise(
    @Param("menuId") menuId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.hubriseCatalog.publishMenu({
      tenantId: user.tenantId,
      menuId,
    });
  }

  @Post("menus/:menuId/import/deliveroo")
  @Roles("MANAGER", "TENANT_OWNER", "PLATFORM_ADMIN")
  @ApiOperation({ summary: "Import Deliveroo menu into the selected menu" })
  importDeliveroo(
    @Param("menuId") menuId: string,
    @Body()
    body: {
      payload?: any;
      storeId?: string;
      deliverooBrandId?: string;
      accessToken?: string;
    },
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.deliverooImporter.import({
      menuId,
      tenantId: user.tenantId,
      payload: body.payload,
      storeId: body.storeId,
      deliverooBrandId: body.deliverooBrandId,
      accessToken: body.accessToken,
    });
  }

  // ── Location-scoped menu lookup (for POS) ─────────────────────────────────
  @Get("locations/:locationId/active-menu")
  @ApiOperation({
    summary: "Find the active menu for a location (used by the POS data load)",
  })
  findActiveMenuForLocation(
    @Param("locationId") locationId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.menus.findActiveMenuForLocation(locationId, user.tenantId);
  }

  // ── Menus ─────────────────────────────────────────────────────────────────

  @Get("brands/:brandId/menus")
  @ApiOperation({ summary: "List menus for a brand" })
  findAll(
    @Param("brandId") brandId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.menus.findAllByBrand(brandId, user.tenantId);
  }

  // Phase AP — operators wanted the Menu tab scoped to the location
  // they're currently working at, not their whole brand. This endpoint
  // returns ONLY the menus whose Menu.locationId matches.
  @Get("locations/:locationId/menus")
  @ApiOperation({ summary: "List menus for a single location" })
  findAllForLocation(
    @Param("locationId") locationId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.menus.findAllByLocation(locationId, user.tenantId);
  }

  @Get("menus/:menuId")
  @ApiOperation({ summary: "Get menu with categories and items" })
  findOne(
    @Param("menuId") menuId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.menus.findOne(menuId, user.tenantId);
  }

  @Post("brands/:brandId/menus")
  @Roles("MANAGER", "TENANT_OWNER", "PLATFORM_ADMIN")
  @ApiOperation({ summary: "Create a menu" })
  create(
    @Param("brandId") brandId: string,
    @Body() dto: CreateMenuDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.menus.create(brandId, user.tenantId, dto);
  }

  @Patch("menus/:menuId")
  @Roles("MANAGER", "TENANT_OWNER", "PLATFORM_ADMIN")
  @ApiOperation({ summary: "Update menu metadata" })
  update(
    @Param("menuId") menuId: string,
    @Body() dto: UpdateMenuDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.menus.update(menuId, user.tenantId, dto);
  }

  @Post("menus/:menuId/publish")
  @Roles("MANAGER", "TENANT_OWNER", "PLATFORM_ADMIN")
  @ApiOperation({ summary: "Publish a menu" })
  publish(
    @Param("menuId") menuId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.menus.publish(menuId, user.tenantId);
  }

  @Post("menus/:menuId/archive")
  @Roles("MANAGER", "TENANT_OWNER", "PLATFORM_ADMIN")
  @ApiOperation({ summary: "Archive a menu" })
  archive(
    @Param("menuId") menuId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.menus.archive(menuId, user.tenantId);
  }

  @Post("menus/:menuId/clone")
  @Roles("MANAGER", "TENANT_OWNER", "PLATFORM_ADMIN")
  @ApiOperation({ summary: "Clone a menu to a new draft" })
  clone(
    @Param("menuId") menuId: string,
    @Body("name") name: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.menus.clone(menuId, user.tenantId, name);
  }

  @Delete("menus/:menuId")
  @Roles("MANAGER", "TENANT_OWNER", "PLATFORM_ADMIN")
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: "Soft-delete a menu" })
  remove(
    @Param("menuId") menuId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.menus.remove(menuId, user.tenantId);
  }

  // ── Categories ────────────────────────────────────────────────────────────

  @Post("menus/:menuId/categories")
  @Roles("MANAGER", "TENANT_OWNER", "PLATFORM_ADMIN")
  @ApiOperation({ summary: "Add a category to a menu" })
  createCategory(
    @Param("menuId") menuId: string,
    @Body() dto: CreateCategoryDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.menus.createCategory(menuId, user.tenantId, dto);
  }

  @Patch("categories/:categoryId")
  @Roles("MANAGER", "TENANT_OWNER", "PLATFORM_ADMIN")
  @ApiOperation({ summary: "Update a category" })
  updateCategory(
    @Param("categoryId") categoryId: string,
    @Body() dto: UpdateCategoryDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.menus.updateCategory(categoryId, user.tenantId, dto);
  }

  @Delete("categories/:categoryId")
  @Roles("MANAGER", "TENANT_OWNER", "PLATFORM_ADMIN")
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: "Remove a category" })
  removeCategory(
    @Param("categoryId") categoryId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.menus.removeCategory(categoryId, user.tenantId);
  }

  @Post("menus/:menuId/categories/reorder")
  @Roles("MANAGER", "TENANT_OWNER", "PLATFORM_ADMIN")
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: "Reorder categories" })
  reorderCategories(
    @Param("menuId") menuId: string,
    @Body() dto: ReorderDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.menus.reorderCategories(menuId, user.tenantId, dto);
  }

  // ── Items ─────────────────────────────────────────────────────────────────

  @Get("brands/:brandId/items")
  @ApiOperation({ summary: "List all items for a brand (item library)" })
  findItems(
    @Param("brandId") brandId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.menus.findItemsByBrand(brandId, user.tenantId);
  }

  // Phase AP — operators want the Products tab scoped to their selected
  // location, not the whole brand. Same pattern the Menu tab uses.
  @Get("locations/:locationId/items")
  @ApiOperation({ summary: "List items for a single location" })
  findItemsForLocation(
    @Param("locationId") locationId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.menus.findItemsByLocation(locationId, user.tenantId);
  }

  @Post("brands/:brandId/items")
  @Roles("MANAGER", "TENANT_OWNER", "PLATFORM_ADMIN")
  @ApiOperation({ summary: "Create a menu item" })
  createItem(
    @Param("brandId") brandId: string,
    @Body() dto: CreateMenuItemDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.menus.createItem(brandId, user.tenantId, dto);
  }

  @Patch("items/:itemId")
  @Roles("MANAGER", "TENANT_OWNER", "PLATFORM_ADMIN")
  @ApiOperation({ summary: "Update a menu item" })
  updateItem(
    @Param("itemId") itemId: string,
    @Body() dto: UpdateMenuItemDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.menus.updateItem(itemId, user.tenantId, dto);
  }

  @Post("items/:itemId/toggle-availability")
  @Roles("CASHIER", "MANAGER", "TENANT_OWNER", "PLATFORM_ADMIN")
  @ApiOperation({ summary: "Toggle item availability on/off" })
  toggleAvailability(
    @Param("itemId") itemId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.menus.toggleAvailability(itemId, user.tenantId);
  }

  @Delete("items/:itemId")
  @Roles("MANAGER", "TENANT_OWNER", "PLATFORM_ADMIN")
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: "Delete a menu item" })
  removeItem(
    @Param("itemId") itemId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.menus.removeItem(itemId, user.tenantId);
  }

  // ── Category ↔ Item links ─────────────────────────────────────────────────

  @Post("categories/:categoryId/items")
  @Roles("MANAGER", "TENANT_OWNER", "PLATFORM_ADMIN")
  @ApiOperation({ summary: "Add existing item to a category" })
  addItemToCategory(
    @Param("categoryId") categoryId: string,
    @Body() dto: AddItemToCategoryDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.menus.addItemToCategory(categoryId, user.tenantId, dto);
  }

  @Delete("categories/:categoryId/items/:itemId")
  @Roles("MANAGER", "TENANT_OWNER", "PLATFORM_ADMIN")
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: "Remove item from category" })
  removeItemFromCategory(
    @Param("categoryId") categoryId: string,
    @Param("itemId") itemId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.menus.removeItemFromCategory(categoryId, itemId, user.tenantId);
  }

  @Patch("categories/:categoryId/items/reorder")
  @Roles("MANAGER", "TENANT_OWNER", "PLATFORM_ADMIN")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Reorder items within a category" })
  reorderItems(
    @Param("categoryId") categoryId: string,
    @Body() body: { order: Array<{ itemId: string; sortOrder: number }> },
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.menus.reorderItemsInCategory(categoryId, user.tenantId, body.order);
  }

  // ── Bulk operations ───────────────────────────────────────────────────────

  @Post("items/bulk/availability")
  @Roles("MANAGER", "TENANT_OWNER", "PLATFORM_ADMIN")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Bulk toggle availability for multiple items" })
  bulkAvailability(
    @Body() body: { itemIds: string[]; isAvailable: boolean },
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.menus.bulkToggleAvailability(body.itemIds, user.tenantId, body.isAvailable);
  }

  @Post("items/bulk/price")
  @Roles("MANAGER", "TENANT_OWNER", "PLATFORM_ADMIN")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Bulk price adjustment" })
  bulkPrice(
    @Body() body: { itemIds: string[]; adjustment: { type: "fixed" | "percentage"; value: number } },
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.menus.bulkUpdatePrice(body.itemIds, user.tenantId, body.adjustment);
  }

  // ── Item variants ─────────────────────────────────────────────────────────

  @Post("items/:itemId/variants")
  @Roles("MANAGER", "TENANT_OWNER", "PLATFORM_ADMIN")
  @ApiOperation({ summary: "Add a size/variant to an item" })
  createVariant(
    @Param("itemId") itemId: string,
    @Body() dto: { name: string; price: number; sku?: string; sortOrder?: number },
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.menus.createVariant(itemId, user.tenantId, dto);
  }

  @Patch("items/variants/:variantId")
  @Roles("MANAGER", "TENANT_OWNER", "PLATFORM_ADMIN")
  @ApiOperation({ summary: "Update a variant" })
  updateVariant(
    @Param("variantId") variantId: string,
    @Body() dto: { name?: string; price?: number; sku?: string; sortOrder?: number; isAvailable?: boolean },
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.menus.updateVariant(variantId, user.tenantId, dto);
  }

  @Delete("items/variants/:variantId")
  @Roles("MANAGER", "TENANT_OWNER", "PLATFORM_ADMIN")
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: "Remove a variant" })
  removeVariant(
    @Param("variantId") variantId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.menus.removeVariant(variantId, user.tenantId);
  }

  // ── Menu versioning ───────────────────────────────────────────────────────

  @Get(":menuId/versions")
  @ApiOperation({ summary: "List menu version history" })
  getVersions(
    @Param("menuId") menuId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.menus.getVersions(menuId, user.tenantId);
  }

  @Post(":menuId/rollback/:versionId")
  @Roles("MANAGER", "TENANT_OWNER", "PLATFORM_ADMIN")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Rollback menu to a previous version" })
  rollback(
    @Param("menuId") menuId: string,
    @Param("versionId") versionId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.menus.rollback(menuId, versionId, user.tenantId);
  }

  // ── Modifier groups ───────────────────────────────────────────────────────

  @Get("brands/:brandId/modifier-groups")
  @ApiOperation({ summary: "List modifier groups for a brand" })
  listModifierGroups(
    @Param("brandId") brandId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.menus.findModifierGroupsByBrand(brandId, user.tenantId);
  }

  // Phase AP — location-scoped modifier groups for the Products tab.
  @Get("locations/:locationId/modifier-groups")
  @ApiOperation({ summary: "List modifier groups for a single location" })
  listModifierGroupsForLocation(
    @Param("locationId") locationId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.menus.findModifierGroupsByLocation(locationId, user.tenantId);
  }

  @Post("brands/:brandId/modifier-groups")
  @Roles("MANAGER", "TENANT_OWNER", "PLATFORM_ADMIN")
  @ApiOperation({ summary: "Create a modifier group" })
  createModifierGroup(
    @Param("brandId") brandId: string,
    @Body()
    dto: {
      name: string;
      description?: string;
      minSelections?: number;
      maxSelections?: number;
      isRequired?: boolean;
      // Phase AP — Products section is location-scoped.
      locationId?: string;
    },
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.menus.createModifierGroup(brandId, user.tenantId, dto);
  }

  @Patch("modifier-groups/:groupId")
  @Roles("MANAGER", "TENANT_OWNER", "PLATFORM_ADMIN")
  @ApiOperation({ summary: "Update a modifier group" })
  updateModifierGroup(
    @Param("groupId") groupId: string,
    @Body() dto: { name?: string; description?: string; minSelections?: number; maxSelections?: number | null; isRequired?: boolean },
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.menus.updateModifierGroup(groupId, user.tenantId, dto);
  }

  @Delete("modifier-groups/:groupId")
  @Roles("MANAGER", "TENANT_OWNER", "PLATFORM_ADMIN")
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: "Delete a modifier group" })
  removeModifierGroup(
    @Param("groupId") groupId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.menus.removeModifierGroup(groupId, user.tenantId);
  }

  @Post("modifier-groups/:groupId/options")
  @Roles("MANAGER", "TENANT_OWNER", "PLATFORM_ADMIN")
  @ApiOperation({ summary: "Add an option to a modifier group" })
  addModifierOption(
    @Param("groupId") groupId: string,
    @Body() dto: { name: string; priceAdjustment?: number; isDefault?: boolean; imageUrl?: string; allergens?: string[]; nestedGroupId?: string },
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.menus.addModifierOption(groupId, user.tenantId, dto);
  }

  @Patch("modifier-options/:optionId")
  @Roles("MANAGER", "TENANT_OWNER", "PLATFORM_ADMIN")
  @ApiOperation({ summary: "Update a modifier option" })
  updateModifierOption(
    @Param("optionId") optionId: string,
    @Body() dto: { name?: string; priceAdjustment?: number; isDefault?: boolean; isAvailable?: boolean; imageUrl?: string; allergens?: string[]; nestedGroupId?: string | null; sortOrder?: number },
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.menus.updateModifierOption(optionId, user.tenantId, dto);
  }

  @Delete("modifier-options/:optionId")
  @Roles("MANAGER", "TENANT_OWNER", "PLATFORM_ADMIN")
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: "Remove a modifier option" })
  removeModifierOption(
    @Param("optionId") optionId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.menus.removeModifierOption(optionId, user.tenantId);
  }

  @Post("items/:itemId/modifier-groups/:groupId")
  @Roles("MANAGER", "TENANT_OWNER", "PLATFORM_ADMIN")
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: "Link a modifier group to an item" })
  linkModifierGroup(
    @Param("itemId") itemId: string,
    @Param("groupId") groupId: string,
    @Body() body: { sortOrder?: number },
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.menus.linkModifierGroupToItem(itemId, groupId, user.tenantId, body.sortOrder);
  }

  @Delete("items/:itemId/modifier-groups/:groupId")
  @Roles("MANAGER", "TENANT_OWNER", "PLATFORM_ADMIN")
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: "Unlink a modifier group from an item" })
  unlinkModifierGroup(
    @Param("itemId") itemId: string,
    @Param("groupId") groupId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.menus.unlinkModifierGroupFromItem(itemId, groupId, user.tenantId);
  }
}
