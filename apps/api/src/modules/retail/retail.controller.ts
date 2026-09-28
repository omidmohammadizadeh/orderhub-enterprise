import { Body, Controller, Get, HttpCode, HttpStatus, Param, Patch, Post, Query } from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";
import { Type } from "class-transformer";
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  ValidateNested,
} from "class-validator";
import { CurrentUser } from "../../common/decorators/current-user.decorator";
import { Roles, TILL_ROLES } from "../../common/decorators/roles.decorator";
import { LocationAccessService } from "../../common/access/location-access.service";
import type { AuthenticatedUser } from "../auth/interfaces/jwt-payload.interface";
import { IMPORT_MAX_ROWS, RetailCatalogService } from "./retail-catalog.service";
import { RetailReturnsService } from "./retail-returns.service";
import { RetailStockService } from "./retail-stock.service";
import { RetailPickingService } from "./retail-picking.service";
import { RetailDealsService } from "./retail-deals.service";

// Building the catalogue and pricing it is a manager's job; counting stock
// and scanning at the till is everyone on shift.
const CATALOG_MANAGE = [
  "PLATFORM_ADMIN",
  "TENANT_OWNER",
  "OWNER",
  "MANAGER",
  "DARK_KITCHEN_MANAGER",
] as const;

class VariantBodyDto {
  @IsOptional() @IsString() @MaxLength(120) name?: string;
  @IsOptional() @IsObject() options?: Record<string, string>;
  @IsOptional() @IsString() @MaxLength(64) barcode?: string | null;
  @IsOptional() @IsString() @MaxLength(64) sku?: string | null;
  @IsOptional() @IsNumber() @Min(0) price?: number | null;
  @IsOptional() @IsNumber() @Min(0) costPrice?: number | null;
  @IsOptional() @IsBoolean() trackStock?: boolean;
  @IsOptional() @IsInt() @Min(0) lowStockAt?: number | null;
  @IsOptional() @IsBoolean() isActive?: boolean;
}

class ImportBodyDto {
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(IMPORT_MAX_ROWS) rows!: Array<Record<string, unknown>>;
  @IsOptional() @IsBoolean() dryRun?: boolean;
}

class AdjustStockBodyDto {
  @IsString() variantId!: string;
  @IsIn(["delta", "count"]) mode!: "delta" | "count";
  @IsInt() quantity!: number;
  @IsOptional() @IsString() @MaxLength(200) reason?: string;
}

class ReturnLineDto {
  @IsString() orderItemId!: string;
  @IsInt() @Min(1) quantity!: number;
  @IsOptional() @IsBoolean() restock?: boolean;
}

class CreateReturnBodyDto {
  @IsString() orderId!: string;
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => ReturnLineDto)
  lines!: ReturnLineDto[];
  @IsOptional() @IsIn(["ORIGINAL", "CASH"]) refundMethod?: "ORIGINAL" | "CASH";
  @IsOptional() @IsString() @MaxLength(200) reason?: string;
  @IsOptional() @IsString() @MaxLength(8) managerPin?: string;
  // Dojo card machine for a card-present refund (the till's pinned one).
  @IsOptional() @IsString() @MaxLength(100) terminalId?: string;
}

class ReceiveLineDto {
  @IsString() variantId!: string;
  @IsInt() @Min(1) quantity!: number;
}

class ReceiveBodyDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(500)
  @ValidateNested({ each: true })
  @Type(() => ReceiveLineDto)
  lines!: ReceiveLineDto[];
  @IsOptional() @IsString() @MaxLength(100) reference?: string;
}

class PickSubDto {
  @IsOptional() @IsString() variantId?: string | null;
  @IsOptional() @IsString() menuItemId?: string | null;
  @IsString() @MaxLength(200) name!: string;
  @IsInt() @Min(1) qty!: number;
  @IsNumber() @Min(0) unitPrice!: number;
}

class PickLineBodyDto {
  @IsInt() @Min(0) picked!: number;
  @IsOptional() @ValidateNested() @Type(() => PickSubDto) sub?: PickSubDto | null;
}

class PollReturnBodyDto {
  @IsString() orderId!: string;
}

@ApiTags("retail")
@ApiBearerAuth()
@Controller({ path: "retail", version: "1" })
export class RetailController {
  constructor(
    private readonly catalog: RetailCatalogService,
    private readonly stock: RetailStockService,
    private readonly returns: RetailReturnsService,
    private readonly picking: RetailPickingService,
    private readonly access: LocationAccessService,
    private readonly deals: RetailDealsService,
  ) {}

  // ── Till ──────────────────────────────────────────────────────────────────

  @Get("locations/:locationId/barcodes")
  @Roles(...TILL_ROLES)
  @ApiOperation({ summary: "Every scannable barcode on this location's till (cached offline by the POS)" })
  async barcodes(@CurrentUser() user: AuthenticatedUser, @Param("locationId") locationId: string) {
    await this.access.assertAccess(user, locationId);
    return this.catalog.barcodeIndex(user.tenantId, locationId);
  }

  @Get("locations/:locationId/deals")
  @Roles(...TILL_ROLES)
  @ApiOperation({ summary: "Multi-buy deals live on this till (POS channel)" })
  async tillDeals(@CurrentUser() user: AuthenticatedUser, @Param("locationId") locationId: string) {
    await this.access.assertAccess(user, locationId);
    return this.deals.tillDeals(user.tenantId, locationId);
  }

  @Get("locations/:locationId/lookup")
  @Roles(...TILL_ROLES)
  @ApiOperation({ summary: "Look up a barcode the till didn't recognise" })
  async lookup(
    @CurrentUser() user: AuthenticatedUser,
    @Param("locationId") locationId: string,
    @Query("code") code: string,
  ) {
    await this.access.assertAccess(user, locationId);
    return this.catalog.lookupBarcode(user.tenantId, locationId, code);
  }

  // ── Catalogue + stock ────────────────────────────────────────────────────

  @Get("locations/:locationId/products")
  @Roles(...TILL_ROLES)
  @ApiOperation({ summary: "Products on this location's till with variants and stock" })
  async products(
    @CurrentUser() user: AuthenticatedUser,
    @Param("locationId") locationId: string,
    @Query("q") q?: string,
    @Query("low") low?: string,
  ) {
    await this.access.assertAccess(user, locationId);
    return this.catalog.listProducts(user.tenantId, locationId, { q, lowOnly: low === "1" || low === "true" });
  }

  @Post("locations/:locationId/import")
  @Roles(...CATALOG_MANAGE)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Import products from spreadsheet rows (parsed in the browser)" })
  async import(
    @CurrentUser() user: AuthenticatedUser,
    @Param("locationId") locationId: string,
    @Body() body: ImportBodyDto,
  ) {
    await this.access.assertAccess(user, locationId);
    return this.catalog.importRows({
      tenantId: user.tenantId,
      locationId,
      userId: user.userId,
      rows: body.rows,
      dryRun: body.dryRun,
    });
  }

  @Post("items/:menuItemId/variants")
  @Roles(...CATALOG_MANAGE)
  @ApiOperation({ summary: "Add a barcoded variant to a product" })
  createVariant(
    @CurrentUser() user: AuthenticatedUser,
    @Param("menuItemId") menuItemId: string,
    @Body() body: VariantBodyDto,
  ) {
    return this.catalog.createVariant(user.tenantId, menuItemId, body);
  }

  @Patch("variants/:variantId")
  @Roles(...CATALOG_MANAGE)
  @ApiOperation({ summary: "Edit a variant (barcode, price, stock settings)" })
  updateVariant(
    @CurrentUser() user: AuthenticatedUser,
    @Param("variantId") variantId: string,
    @Body() body: VariantBodyDto,
  ) {
    return this.catalog.updateVariant(user.tenantId, variantId, body);
  }

  @Post("locations/:locationId/stock/adjust")
  @Roles(...TILL_ROLES)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Change stock by a delta, or set it to a counted figure" })
  async adjust(
    @CurrentUser() user: AuthenticatedUser,
    @Param("locationId") locationId: string,
    @Body() body: AdjustStockBodyDto,
  ) {
    await this.access.assertAccess(user, locationId);
    return this.stock.adjust({
      tenantId: user.tenantId,
      locationId,
      variantId: body.variantId,
      userId: user.userId,
      mode: body.mode,
      quantity: body.quantity,
      reason: body.reason,
    });
  }

  @Post("locations/:locationId/stock/receive")
  @Roles(...TILL_ROLES)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Book a delivery scanned in at the back door" })
  async receive(
    @CurrentUser() user: AuthenticatedUser,
    @Param("locationId") locationId: string,
    @Body() body: ReceiveBodyDto,
  ) {
    await this.access.assertAccess(user, locationId);
    return this.stock.receive({
      tenantId: user.tenantId,
      locationId,
      userId: user.userId,
      reference: body.reference,
      lines: body.lines,
    });
  }

  @Get("locations/:locationId/stock/report")
  @Roles(...TILL_ROLES)
  @ApiOperation({ summary: "Stock on hand, value at cost, low-stock count" })
  async report(@CurrentUser() user: AuthenticatedUser, @Param("locationId") locationId: string) {
    await this.access.assertAccess(user, locationId);
    return this.stock.report(user.tenantId, locationId);
  }

  // ── Picking (online orders at a shop) ─────────────────────────────────────

  @Get("locations/:locationId/picking")
  @Roles(...TILL_ROLES)
  @ApiOperation({ summary: "Online orders to pick, with aisles, barcodes and substitution choices" })
  async pickList(@CurrentUser() user: AuthenticatedUser, @Param("locationId") locationId: string) {
    await this.access.assertAccess(user, locationId);
    return this.picking.list(user, locationId);
  }

  @Post("picking/:orderId/start")
  @Roles(...TILL_ROLES)
  @HttpCode(HttpStatus.OK)
  startPicking(@CurrentUser() user: AuthenticatedUser, @Param("orderId") orderId: string) {
    return this.picking.start(user, orderId);
  }

  @Patch("picking/:orderId/lines/:itemId")
  @Roles(...TILL_ROLES)
  pickLine(
    @CurrentUser() user: AuthenticatedUser,
    @Param("orderId") orderId: string,
    @Param("itemId") itemId: string,
    @Body() body: PickLineBodyDto,
  ) {
    return this.picking.setLine(user, orderId, itemId, { picked: body.picked, sub: body.sub ?? null } as any);
  }

  @Post("picking/:orderId/complete")
  @Roles(...TILL_ROLES)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Finish picking: refund the shortfall, fix stock, mark ready" })
  completePicking(@CurrentUser() user: AuthenticatedUser, @Param("orderId") orderId: string) {
    return this.picking.complete(user, orderId);
  }

  @Get("locations/:locationId/stock/:variantId/history")
  @Roles(...TILL_ROLES)
  async history(
    @CurrentUser() user: AuthenticatedUser,
    @Param("locationId") locationId: string,
    @Param("variantId") variantId: string,
  ) {
    await this.access.assertAccess(user, locationId);
    return this.stock.history(user.tenantId, locationId, variantId);
  }

  // ── Returns ──────────────────────────────────────────────────────────────

  @Get("locations/:locationId/returns/lookup")
  @Roles(...TILL_ROLES)
  @ApiOperation({ summary: "Find a sale from its receipt QR or number, with what can still be returned" })
  async findSale(
    @CurrentUser() user: AuthenticatedUser,
    @Param("locationId") locationId: string,
    @Query("code") code: string,
  ) {
    await this.access.assertAccess(user, locationId);
    return this.returns.findSale(user, locationId, code);
  }

  @Post("returns")
  @Roles(...TILL_ROLES)
  @ApiOperation({ summary: "Return items from a sale: refund them and put them back in stock" })
  createReturn(@CurrentUser() user: AuthenticatedUser, @Body() body: CreateReturnBodyDto) {
    return this.returns.createReturn(user, body);
  }

  @Post("returns/dojo/poll")
  @Roles(...TILL_ROLES)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Poll a return being refunded on the Dojo card machine" })
  pollDojoReturn(@CurrentUser() user: AuthenticatedUser, @Body() body: PollReturnBodyDto) {
    return this.returns.pollDojoReturn(user, body.orderId);
  }
}
