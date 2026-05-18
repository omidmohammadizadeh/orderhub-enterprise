import {
  IsString,
  IsOptional,
  IsNumber,
  IsArray,
  IsEnum,
  IsObject,
  ValidateNested,
  IsPositive,
  Min,
} from "class-validator";
import { Type } from "class-transformer";
import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import type { FulfillmentType, OrderSource } from "@orderhub/database";

export class OrderModifierDto {
  @ApiProperty() @IsString() name!: string;
  @ApiProperty() @IsNumber() price!: number;
  @ApiPropertyOptional() @IsOptional() @IsNumber() quantity?: number;
}

export class CreateOrderItemDto {
  @ApiProperty() @IsString() name!: string;
  @ApiProperty() @IsNumber() @IsPositive() quantity!: number;
  @ApiProperty() @IsNumber() @Min(0) unitPrice!: number;
  @ApiProperty() @IsNumber() @Min(0) totalPrice!: number;
  @ApiPropertyOptional() @IsOptional() @IsString() notes?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() sku?: string;
  @ApiPropertyOptional()
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => OrderModifierDto)
  modifiers?: OrderModifierDto[];
}

export class CustomerInfoDto {
  @ApiProperty() @IsString() name!: string;
  @ApiPropertyOptional() @IsOptional() @IsString() phone?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() email?: string;
}

export class DeliveryAddressDto {
  @ApiProperty() @IsString() line1!: string;
  @ApiPropertyOptional() @IsOptional() @IsString() line2?: string;
  @ApiProperty() @IsString() city!: string;
  @ApiProperty() @IsString() postcode!: string;
  @ApiPropertyOptional() @IsOptional() @IsString() country?: string;
}

export class CreateOrderDto {
  @ApiProperty() @IsString() locationId!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsEnum(["ONLINE", "POS", "UBER_EATS", "DELIVEROO", "JUST_EAT", "HUBRISE", "DIRECT"])
  orderSource?: OrderSource;

  @ApiPropertyOptional()
  @IsOptional()
  @IsEnum(["PICKUP", "DELIVERY", "DINE_IN", "MERCHANT_DELIVERY", "PLATFORM_COURIER"])
  fulfillmentType?: FulfillmentType;

  @ApiPropertyOptional() @IsOptional() @IsString() specialInstructions?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() scheduledFor?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() idempotencyKey?: string;

  @ApiProperty()
  @ValidateNested()
  @Type(() => CustomerInfoDto)
  customerInfo!: CustomerInfoDto;

  @ApiPropertyOptional()
  @IsOptional()
  @ValidateNested()
  @Type(() => DeliveryAddressDto)
  deliveryAddress?: DeliveryAddressDto;

  @ApiProperty()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => CreateOrderItemDto)
  items!: CreateOrderItemDto[];

  @ApiProperty() @IsNumber() @Min(0) subtotal!: number;
  @ApiPropertyOptional() @IsOptional() @IsNumber() @Min(0) taxAmount?: number;
  @ApiPropertyOptional() @IsOptional() @IsNumber() @Min(0) deliveryFee?: number;
  @ApiPropertyOptional() @IsOptional() @IsNumber() @Min(0) discount?: number;
  @ApiProperty() @IsNumber() @Min(0) total!: number;
}
