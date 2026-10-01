// Phase AW-19 — Marketing campaign DTOs.
//
// MarketingCampaign covers seven offer types; this DTO is permissive on
// type-specific fields so the same shape works for all of them. The
// service validates the cross-field rules per type (e.g. PERCENTAGE_OFF
// must have a percentageOff value, HAPPY_HOUR must have dailyStart/End).

import {
  IsString,
  IsOptional,
  IsArray,
  IsEnum,
  IsNumber,
  IsBoolean,
  IsISO8601,
  Min,
  Max,
  MaxLength,
} from "class-validator";
import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { Type } from "class-transformer";
import { ArrayMaxSize, IsIn, IsInt, ValidateNested } from "class-validator";

// MULTI_BUY — stored on metadata.multiBuy; itemIds is the pool for the
// quantity modes. Rules live in @orderhub/shared validateMultiBuy.
export class MultiBuySlotDto {
  @IsString() @MaxLength(60) name!: string;
  @IsArray() @ArrayMaxSize(500) @IsString({ each: true }) itemIds!: string[];
}

export class MultiBuyConfigDto {
  @IsIn(["FIXED_PRICE", "CHEAPEST_FREE", "MEAL_DEAL"]) mode!: "FIXED_PRICE" | "CHEAPEST_FREE" | "MEAL_DEAL";
  @IsOptional() @IsInt() @Min(2) @Max(50) quantity?: number;
  @IsOptional() @IsNumber() @Min(0) price?: number;
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(6)
  @ValidateNested({ each: true })
  @Type(() => MultiBuySlotDto)
  slots?: MultiBuySlotDto[];
}

export const CAMPAIGN_TYPES = [
  "PERCENTAGE_OFF",
  "AMOUNT_OFF_ORDER",
  "PERCENT_OFF_ITEMS",
  "BOGO",
  "FREE_ITEM",
  "FREE_DELIVERY",
  "HAPPY_HOUR",
  "MULTI_BUY",
] as const;
export type CampaignTypeValue = (typeof CAMPAIGN_TYPES)[number];

export const CAMPAIGN_STATUSES = ["DRAFT", "ACTIVE", "PAUSED", "ENDED"] as const;
export type CampaignStatusValue = (typeof CAMPAIGN_STATUSES)[number];

export const CAMPAIGN_AUDIENCES = ["ALL", "NEW", "RETURNING", "LAPSED"] as const;
export type CampaignAudienceValue = (typeof CAMPAIGN_AUDIENCES)[number];

export class CreateCampaignDto {
  @ApiProperty() @IsString() brandId!: string;
  @ApiProperty() @IsString() @MaxLength(120) name!: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(500) description?: string;

  @ApiProperty({ enum: CAMPAIGN_TYPES })
  @IsEnum(CAMPAIGN_TYPES)
  type!: CampaignTypeValue;

  @ApiPropertyOptional({ enum: CAMPAIGN_STATUSES })
  @IsOptional()
  @IsEnum(CAMPAIGN_STATUSES)
  status?: CampaignStatusValue;

  @ApiPropertyOptional({ enum: CAMPAIGN_AUDIENCES })
  @IsOptional()
  @IsEnum(CAMPAIGN_AUDIENCES)
  audience?: CampaignAudienceValue;

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  channels?: string[];

  @ApiPropertyOptional() @IsOptional() @IsNumber() @Min(0) @Max(100) percentageOff?: number;
  @ApiPropertyOptional() @IsOptional() @IsNumber() @Min(0) amountOff?: number;
  @ApiPropertyOptional() @IsOptional() @IsNumber() @Min(0) minOrder?: number;
  @ApiPropertyOptional() @IsOptional() @IsString() freeItemId?: string;
  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  itemIds?: string[];
  // Phase AW-19 — BOGO reward items. Stored on metadata.rewardItemIds.
  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  rewardItemIds?: string[];
  // Phase AW-19 — FREE_ITEM excluded category ids (kept off the
  // spend threshold). Stored on metadata.excludedCategoryIds.
  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  excludedCategoryIds?: string[];
  // Phase AW-19 — HAPPY_HOUR day-of-week gate (0=Sun…6=Sat).
  // Stored on metadata.daysOfWeek. Empty = every day.
  @ApiPropertyOptional({ type: [Number] })
  @IsOptional()
  @IsArray()
  @IsNumber({}, { each: true })
  daysOfWeek?: number[];
  @ApiPropertyOptional({ type: MultiBuyConfigDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => MultiBuyConfigDto)
  multiBuy?: MultiBuyConfigDto;
  @ApiPropertyOptional() @IsOptional() @IsString() dailyStartTime?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() dailyEndTime?: string;
  @ApiPropertyOptional() @IsOptional() @IsISO8601() startsAt?: string;
  @ApiPropertyOptional() @IsOptional() @IsISO8601() endsAt?: string;
  @ApiPropertyOptional() @IsOptional() @IsNumber() @Min(1) maxRedemptions?: number;
  @ApiPropertyOptional() @IsOptional() @IsNumber() @Min(1) perCustomerLimit?: number;
}

export class UpdateCampaignDto {
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(120) name?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(500) description?: string;
  @ApiPropertyOptional({ enum: CAMPAIGN_STATUSES })
  @IsOptional()
  @IsEnum(CAMPAIGN_STATUSES)
  status?: CampaignStatusValue;
  @ApiPropertyOptional({ enum: CAMPAIGN_AUDIENCES })
  @IsOptional()
  @IsEnum(CAMPAIGN_AUDIENCES)
  audience?: CampaignAudienceValue;
  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  channels?: string[];
  @ApiPropertyOptional() @IsOptional() @IsNumber() @Min(0) @Max(100) percentageOff?: number;
  @ApiPropertyOptional() @IsOptional() @IsNumber() @Min(0) amountOff?: number;
  @ApiPropertyOptional() @IsOptional() @IsNumber() @Min(0) minOrder?: number;
  @ApiPropertyOptional() @IsOptional() @IsString() freeItemId?: string;
  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  itemIds?: string[];
  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  rewardItemIds?: string[];
  @ApiPropertyOptional({ type: MultiBuyConfigDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => MultiBuyConfigDto)
  multiBuy?: MultiBuyConfigDto;
  @ApiPropertyOptional() @IsOptional() @IsString() dailyStartTime?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() dailyEndTime?: string;
  @ApiPropertyOptional() @IsOptional() @IsISO8601() startsAt?: string;
  @ApiPropertyOptional() @IsOptional() @IsISO8601() endsAt?: string;
  @ApiPropertyOptional() @IsOptional() @IsNumber() @Min(1) maxRedemptions?: number;
  @ApiPropertyOptional() @IsOptional() @IsNumber() @Min(1) perCustomerLimit?: number;
}
