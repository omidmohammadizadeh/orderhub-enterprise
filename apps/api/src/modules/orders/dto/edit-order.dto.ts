// Phase AW-22 — Edit a POS order in place.
//
// Scope is intentionally narrower than CreateOrderDto: we accept a
// replacement item list + recomputed totals + customer details.
// Everything else (location, brand, fulfillment, payment method,
// orderSource, scheduledFor) is left untouched — the operator can't
// change "what kind of order this is", only what's in it.

import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { Type } from "class-transformer";
import {
  IsArray,
  IsNumber,
  IsOptional,
  IsString,
  Min,
  ValidateNested,
} from "class-validator";
import {
  CreateOrderItemDto,
  CustomerInfoDto,
  DeliveryAddressDto,
} from "./create-order.dto";

export class EditOrderDto {
  @ApiProperty({ type: [CreateOrderItemDto] })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => CreateOrderItemDto)
  items!: CreateOrderItemDto[];

  @ApiProperty() @IsNumber() @Min(0) subtotal!: number;
  @ApiPropertyOptional() @IsOptional() @IsNumber() @Min(0) taxAmount?: number;
  @ApiPropertyOptional() @IsOptional() @IsNumber() @Min(0) deliveryFee?: number;
  @ApiPropertyOptional() @IsOptional() @IsNumber() @Min(0) discount?: number;
  @ApiProperty() @IsNumber() @Min(0) total!: number;

  @ApiPropertyOptional({ type: CustomerInfoDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => CustomerInfoDto)
  customerInfo?: CustomerInfoDto;

  @ApiPropertyOptional({ type: DeliveryAddressDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => DeliveryAddressDto)
  deliveryAddress?: DeliveryAddressDto;

  @ApiPropertyOptional() @IsOptional() @IsString() specialInstructions?: string;
}
