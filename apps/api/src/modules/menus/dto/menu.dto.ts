import {
  IsString,
  IsOptional,
  IsBoolean,
  IsNumber,
  IsArray,
  IsEnum,
  IsObject,
  ValidateNested,
  Min,
  Max,
  IsPositive,
  MaxLength,
  ArrayMaxSize,
} from "class-validator";
import { Type } from "class-transformer";
import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";

// ── Modifier option (leaf node) ───────────────────────────────────────────────
export class ModifierOptionDto {
  @ApiProperty() @IsString() @MaxLength(120) name!: string;
  @ApiProperty() @IsNumber() @Min(0) priceAdjustment!: number;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() isDefault?: boolean;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() isAvailable?: boolean;
  @ApiPropertyOptional() @IsOptional() @IsString() sku?: string;
  // Per-variant price overrides keyed by pricing-variant ref.
  @ApiPropertyOptional() @IsOptional() @IsObject() platformPricingOverrides?: Record<string, number>;
}

// ── Modifier group ─────────────────────────────────────────────────────────────
export class ModifierGroupDto {
  @ApiProperty() @IsString() @MaxLength(120) name!: string;
  @ApiPropertyOptional() @IsOptional() @IsString() description?: string;
  @ApiProperty() @IsBoolean() isRequired!: boolean;
  @ApiProperty() @IsNumber() @Min(1) minSelections!: number;
  @ApiProperty() @IsNumber() @Min(1) maxSelections!: number;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() allowMultiple?: boolean;

  @ApiProperty({ type: [ModifierOptionDto] })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ModifierOptionDto)
  @ArrayMaxSize(40)
  options!: ModifierOptionDto[];
}

// ── Create menu ───────────────────────────────────────────────────────────────
// Phase AM — Deliverect-style create form sends menuType + banner/logo
// image URLs alongside the basics. All optional so older clients still
// work; whitelisted so the global ValidationPipe lets them through
// instead of 400'ing with "property X should not exist".
export class CreateMenuDto {
  @ApiProperty() @IsString() @MaxLength(120) name!: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(500) description?: string;
  @ApiPropertyOptional()
  @IsOptional()
  @IsEnum(["DELIVERY", "DELIVERY_AND_PICKUP"])
  menuType?: string;
  // Banner is the 1920×1080 hero shown on the customer storefront; logo
  // is the 1:1 brand badge. Both ship as data: URLs today via the
  // canvas-side resize; the same field will hold a Supabase Storage URL
  // once that upload lands.
  @ApiPropertyOptional() @IsOptional() @IsString() bannerImage?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() logoImage?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() heroImage?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() locationId?: string;
  @ApiPropertyOptional()
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  publishedTo?: string[];
}

// Phase BC — Master Menu. Merges the categories/items of several existing
// menus (typically one per brand) at a location into one combined menu, so
// a single HubRise connection (one menu per location) can carry every
// brand's catalog via per-brand pricing variants + restrictions.
export class CreateMasterMenuDto {
  @ApiProperty() @IsString() @MaxLength(120) name!: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(500) description?: string;
  @ApiProperty({ type: [String] })
  @IsArray()
  @ArrayMaxSize(50)
  @IsString({ each: true })
  sourceMenuIds!: string[];
}

/** The menus composing a location's single HubRise catalog. Replace
 *  semantics — whatever is sent becomes the complete set. */
export class SetHubRiseCatalogMenusDto {
  @ApiProperty({ type: [String] })
  @IsArray()
  @ArrayMaxSize(50)
  @IsString({ each: true })
  menuIds!: string[];
}

export class UpdateMenuDto {
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(120) name?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(500) description?: string;
  @ApiPropertyOptional() @IsOptional() @IsEnum(["DRAFT", "PUBLISHED", "ARCHIVED"]) status?: string;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() isActive?: boolean;
  @ApiPropertyOptional()
  @IsOptional()
  @IsEnum(["DELIVERY", "DELIVERY_AND_PICKUP"])
  menuType?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() bannerImage?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() logoImage?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() heroImage?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() locationId?: string;
  // Phase BA — the locations this menu should SERVE (multi-select in the
  // publish modal). Sent together with publishedTo, the service rewrites
  // the selected locations' serving assignments in one transaction:
  // replace per (location, channel, brand) slot, other locations kept.
  @ApiPropertyOptional()
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  locationIds?: string[];
  // Phase AM — publish target picker. The service stamps lastPublishedAt
  // whenever this comes in non-empty.
  @ApiPropertyOptional()
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  publishedTo?: string[];
  // Phase AW — re-assign the menu to a brand at publish time. Picker
  // shows brands at the menu's current location; the service verifies
  // the destination brand belongs to the caller's tenant before moving.
  @ApiPropertyOptional() @IsOptional() @IsString() brandId?: string;
  // Phase AZ — named pricing variants on this menu. Each is
  // { ref, name, channelKey? }; the service normalises + dedupes.
  // Plain-object array (no nested DTO) so the elements pass through the
  // global ValidationPipe untouched.
  @ApiPropertyOptional() @IsOptional() @IsArray() pricingVariants?: Array<Record<string, unknown>>;
}

// ── Create category ───────────────────────────────────────────────────────────
export class CreateCategoryDto {
  @ApiProperty() @IsString() @MaxLength(120) name!: string;
  @ApiPropertyOptional() @IsOptional() @IsNumber() @Min(0) sortOrder?: number;
}

export class UpdateCategoryDto {
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(120) name?: string;
  @ApiPropertyOptional() @IsOptional() @IsNumber() @Min(0) sortOrder?: number;
}

// ── Product SKU row ──────────────────────────────────────────────────────────
// Phase AL — one row in MenuItem.productSkus[] (multi-SKU pizza-style
// products). Needs to be a real class with class-validator metadata so
// the global ValidationPipe (whitelist: true + transform: true) doesn't
// silently strip every field on the way through. Without this DTO the
// payload [{name, plu, price, modifierGroups}, ...] becomes [[], ...]
// in the database — the symptom the operator surfaced as "SKU names
// disappear after saving and re-opening".
export class ProductSkuDto {
  @ApiProperty() @IsString() @MaxLength(120) name!: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(80) plu?: string;
  @ApiPropertyOptional() @IsOptional() @IsNumber() @Min(0) price?: number;
  @ApiPropertyOptional()
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  modifierGroups?: string[];
  // Per-variant price overrides for THIS size, keyed by pricing-variant
  // ref, e.g. { "UBER_EATS": 11.99 }. Whitelisted so the nested object
  // survives the global ValidationPipe.
  @ApiPropertyOptional() @IsOptional() @IsObject() priceOverrides?: Record<string, number>;
}

// ── Create menu item ──────────────────────────────────────────────────────────
//
// Phase AL note: the master-catalog Products form sends Base44-style
// fields (plu, hasMultipleSkus, productSkus JSON, per-channel taxes,
// out-of-stock + visibleToCustomers toggles, etc.). They're all optional
// here so older clients keep working, but they MUST be on the DTO
// because main.ts ships `forbidNonWhitelisted: true` — any unknown field
// triggers a 400 before the service ever runs.
export class CreateMenuItemDto {
  @ApiProperty() @IsString() @MaxLength(200) name!: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(1000) description?: string;
  @ApiProperty() @IsNumber() @Min(0) basePrice!: number;
  // Kitchen-language name. Customers always see `name`; the kitchen ticket
  // prints this instead when the location has translations switched on.
  // Nullable so clearing the box removes the translation rather than storing
  // an empty string that reads as "translated to nothing".
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(200) secondLanguageName?: string | null;
  @ApiPropertyOptional() @IsOptional() @IsString() imageUrl?: string;
  // sku is the legacy column; plu is the Phase AK authoritative field.
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(80) sku?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(80) plu?: string;
  @ApiPropertyOptional() @IsOptional() @IsNumber() @Min(0) calories?: number;
  @ApiPropertyOptional() @IsOptional() @IsArray() @IsString({ each: true }) allergens?: string[];
  @ApiPropertyOptional() @IsOptional() @IsArray() @IsString({ each: true }) dietaryTags?: string[];
  @ApiPropertyOptional() @IsOptional() @IsBoolean() isAvailable?: boolean;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() outOfStock?: boolean;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() visibleToCustomers?: boolean;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() hasMultipleSkus?: boolean;
  @ApiPropertyOptional({ type: [ProductSkuDto] })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ProductSkuDto)
  @ArrayMaxSize(20)
  productSkus?: ProductSkuDto[];
  @ApiPropertyOptional() @IsOptional() @IsNumber() @Min(0) deliveryTax?: number;
  @ApiPropertyOptional() @IsOptional() @IsNumber() @Min(0) takeawayTax?: number;
  @ApiPropertyOptional() @IsOptional() @IsNumber() @Min(0) eatInTax?: number;
  @ApiPropertyOptional() @IsOptional() @IsArray() @IsString({ each: true }) menuIds?: string[];
  @ApiPropertyOptional() @IsOptional() @IsArray() @IsString({ each: true }) brandIds?: string[];
  @ApiPropertyOptional() @IsOptional() @IsObject() platformPricingOverrides?: Record<string, number>;
  // Phase AP — Products section is location-scoped.
  @ApiPropertyOptional() @IsOptional() @IsString() locationId?: string;

  @ApiPropertyOptional({ type: [ModifierGroupDto] })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ModifierGroupDto)
  @ArrayMaxSize(20)
  modifierGroups?: ModifierGroupDto[];
}

export class UpdateMenuItemDto {
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(200) name?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(1000) description?: string;
  @ApiPropertyOptional() @IsOptional() @IsNumber() @Min(0) basePrice?: number;
  // Kitchen-language name. Customers always see `name`; the kitchen ticket
  // prints this instead when the location has translations switched on.
  // Nullable so clearing the box removes the translation rather than storing
  // an empty string that reads as "translated to nothing".
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(200) secondLanguageName?: string | null;
  @ApiPropertyOptional() @IsOptional() @IsString() imageUrl?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(80) sku?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(80) plu?: string;
  @ApiPropertyOptional() @IsOptional() @IsNumber() @Min(0) calories?: number;
  @ApiPropertyOptional() @IsOptional() @IsArray() @IsString({ each: true }) allergens?: string[];
  @ApiPropertyOptional() @IsOptional() @IsArray() @IsString({ each: true }) dietaryTags?: string[];
  @ApiPropertyOptional() @IsOptional() @IsBoolean() isAvailable?: boolean;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() outOfStock?: boolean;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() visibleToCustomers?: boolean;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() hasMultipleSkus?: boolean;
  @ApiPropertyOptional({ type: [ProductSkuDto] })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ProductSkuDto)
  @ArrayMaxSize(20)
  productSkus?: ProductSkuDto[];
  @ApiPropertyOptional() @IsOptional() @IsNumber() @Min(0) deliveryTax?: number;
  @ApiPropertyOptional() @IsOptional() @IsNumber() @Min(0) takeawayTax?: number;
  @ApiPropertyOptional() @IsOptional() @IsNumber() @Min(0) eatInTax?: number;
  @ApiPropertyOptional() @IsOptional() @IsArray() @IsString({ each: true }) menuIds?: string[];
  @ApiPropertyOptional() @IsOptional() @IsArray() @IsString({ each: true }) brandIds?: string[];
  @ApiPropertyOptional() @IsOptional() @IsObject() platformPricingOverrides?: Record<string, number>;
  // Phase AP — Products section is location-scoped.
  @ApiPropertyOptional() @IsOptional() @IsString() locationId?: string;

  @ApiPropertyOptional({ type: [ModifierGroupDto] })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ModifierGroupDto)
  @ArrayMaxSize(20)
  modifierGroups?: ModifierGroupDto[];
}

// ── Add item to category ──────────────────────────────────────────────────────
export class AddItemToCategoryDto {
  @ApiProperty() @IsString() itemId!: string;
  @ApiPropertyOptional() @IsOptional() @IsNumber() @Min(0) sortOrder?: number;
  @ApiPropertyOptional() @IsOptional() @IsNumber() @Min(0) priceOverride?: number;
}

// ── Reorder categories ────────────────────────────────────────────────────────
export class ReorderItemDto {
  @ApiProperty() @IsString() id!: string;
  @ApiProperty() @IsNumber() @Min(0) sortOrder!: number;
}

export class ReorderDto {
  @ApiProperty({ type: [ReorderItemDto] })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ReorderItemDto)
  items!: ReorderItemDto[];
}

// ── Apply one item's configuration to others ─────────────────────────────────
// Modifier groups are LINKED (shared brand-level rows), sizes are COPIED with
// fresh per-item PLUs. See MenusService.applyItemConfigToItems.
export class ApplyItemConfigDto {
  @ApiProperty({ type: [String], description: "Items to apply to" })
  @IsArray()
  @IsString({ each: true })
  @ArrayMaxSize(500)
  targetItemIds!: string[];

  @ApiPropertyOptional({ type: [String], description: "Modifier groups to attach" })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @ArrayMaxSize(50)
  modifierGroupIds?: string[];

  @ApiPropertyOptional({ description: "Also copy this item's size/SKU set" })
  @IsOptional()
  @IsBoolean()
  includeSkus?: boolean;
}

/**
 * One percentage per channel, applied to every price in a menu.
 *
 * Percent is an UPLIFT on the base price, not the resulting price: 20 means
 * "list 20% higher on this channel". 0 means "same as base" and clears any
 * override, so the channel simply follows the base price from then on.
 */
export class ChannelPricingChannelDto {
  @ApiProperty() @IsString() channelKey!: string;
  @ApiPropertyOptional() @IsOptional() @IsString() name?: string;
  @ApiProperty() @IsNumber() @Min(0) @Max(200) percent!: number;
}

export class ApplyChannelPricingDto {
  @ApiProperty() @IsString() brandId!: string;
  @ApiProperty({ type: [ChannelPricingChannelDto] })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ChannelPricingChannelDto)
  channels!: ChannelPricingChannelDto[];
}
