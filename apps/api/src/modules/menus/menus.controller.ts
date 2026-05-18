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
  constructor(private readonly menus: MenusService) {}

  // ── Menus ─────────────────────────────────────────────────────────────────

  @Get("brands/:brandId/menus")
  @ApiOperation({ summary: "List menus for a brand" })
  findAll(
    @Param("brandId") brandId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.menus.findAllByBrand(brandId, user.tenantId);
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
}
