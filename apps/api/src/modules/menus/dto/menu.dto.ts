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
export class CreateMenuDto {
  @ApiProperty() @IsString() @MaxLength(120) name!: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(500) description?: string;
}

export class UpdateMenuDto {
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(120) name?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(500) description?: string;
  @ApiPropertyOptional() @IsOptional() @IsEnum(["DRAFT", "PUBLISHED", "ARCHIVED"]) status?: string;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() isActive?: boolean;
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
  @ApiPropertyOptional() @IsOptional() productSkus?: unknown[];
  @ApiPropertyOptional() @IsOptional() @IsNumber() @Min(0) deliveryTax?: number;
  @ApiPropertyOptional() @IsOptional() @IsNumber() @Min(0) takeawayTax?: number;
  @ApiPropertyOptional() @IsOptional() @IsNumber() @Min(0) eatInTax?: number;
  @ApiPropertyOptional() @IsOptional() @IsArray() @IsString({ each: true }) menuIds?: string[];
  @ApiPropertyOptional() @IsOptional() @IsArray() @IsString({ each: true }) brandIds?: string[];
  @ApiPropertyOptional() @IsOptional() @IsObject() platformPricingOverrides?: Record<string, number>;

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
  @ApiPropertyOptional() @IsOptional() productSkus?: unknown[];
  @ApiPropertyOptional() @IsOptional() @IsNumber() @Min(0) deliveryTax?: number;
  @ApiPropertyOptional() @IsOptional() @IsNumber() @Min(0) takeawayTax?: number;
  @ApiPropertyOptional() @IsOptional() @IsNumber() @Min(0) eatInTax?: number;
  @ApiPropertyOptional() @IsOptional() @IsArray() @IsString({ each: true }) menuIds?: string[];
  @ApiPropertyOptional() @IsOptional() @IsArray() @IsString({ each: true }) brandIds?: string[];
  @ApiPropertyOptional() @IsOptional() @IsObject() platformPricingOverrides?: Record<string, number>;

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
