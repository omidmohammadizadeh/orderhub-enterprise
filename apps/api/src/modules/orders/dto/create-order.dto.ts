import {
  IsString,
  IsOptional,
  IsNumber,
  IsBoolean,
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
  // KDS station routing matches items by MenuItem id (category/item rules).
  // POS sends it so kitchen screens with routing rules work for POS orders.
  @ApiPropertyOptional() @IsOptional() @IsString() menuItemId?: string;
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

  // Phase AW — pin the order to a specific virtual brand at this
  // location. POS sends the brandId of the active menu so the
  // Orders board column + the printed receipt header pick up the
  // right brand. Storefront orders use the same field via the
  // /ordering/store/:slug?brand=<id> pinning path.
  @ApiPropertyOptional() @IsOptional() @IsString() brandId?: string;

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
  // Table Tabs — set on a DINE_IN order that is a table's running tab.
  @ApiPropertyOptional() @IsOptional() @IsString() tableId?: string;

  // Counter trade — POS walk-in or a self-service kiosk. Tagged rather than
  // inferred from the customer name, so the walk-in report can't be fooled
  // by a customer actually called "Walk-in".
  @ApiPropertyOptional() @IsOptional() @IsBoolean() isWalkIn?: boolean;

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
  /** Customer gratuity, kept by the restaurant. */
  @ApiPropertyOptional() @IsOptional() @IsNumber() @Min(0) tipAmount?: number;
  @ApiProperty() @IsNumber() @Min(0) total!: number;

  // ── Phase AM — POS operational fields ─────────────────────
  // The global ValidationPipe runs `forbidNonWhitelisted: true`, so every new
  // field the POS sends must be declared here or the request 400s before the
  // handler ever runs.
  @ApiPropertyOptional() @IsOptional() @IsString() callerId?: string;
  @ApiPropertyOptional() @IsOptional() @IsNumber() @Min(0) preparationMinutes?: number;
  @ApiPropertyOptional()
  @IsOptional()
  @IsEnum(["PERCENT_10", "PERCENT_20", "FREE_DELIVERY", "PROMO_CODE", "MANUAL"])
  discountType?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() promoCode?: string;
  @ApiPropertyOptional()
  @IsOptional()
  @IsEnum(["CASH", "CARD_TERMINAL", "ONLINE_CARD", "PAYMENT_LINK", "QR_CODE", "EXTERNAL"])
  paymentMethod?: string;
  @ApiPropertyOptional()
  @IsOptional()
  @IsEnum(["MANUAL", "STRIPE", "DOJO", "ADYEN", "WORLDPAY"])
  paymentProvider?: string;
  @ApiPropertyOptional()
  @IsOptional()
  @IsEnum(["PENDING", "PAID", "FAILED", "REFUNDED"])
  paymentStatus?: string;
  /** Whether the operator marked this order as scheduled-for-the-future. When
   *  true, no PrinterJob is created at order-creation time. */
  @ApiPropertyOptional() @IsOptional() @IsBoolean() isScheduled?: boolean;
  /** SMS-marketing consent captured at checkout (POS/online "Send me offers by
   *  SMS" box). true → opt the customer in; false → opt out. Undefined = not
   *  asked, leave marketing consent untouched. */
  @ApiPropertyOptional() @IsOptional() @IsBoolean() marketingConsent?: boolean;
}
