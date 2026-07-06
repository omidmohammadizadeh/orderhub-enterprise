// Phase AW-14 — Menu Availability (86 board) REST endpoints.
// Phase BA — per-location scoping: snooze/unsnooze accept an optional
// locationId, "ALL" joins the channel list ("86 here entirely"), the
// matrix takes a ?locationId= context, and a small read backs the
// products-tab location toggle.

import {
  Controller,
  Get,
  Post,
  Body,
  Param,
  Query,
  HttpCode,
  HttpStatus,
} from "@nestjs/common";
import { ApiTags, ApiOperation } from "@nestjs/swagger";
import {
  IsString,
  IsOptional,
  IsIn,
  IsISO8601,
  MaxLength,
} from "class-validator";
import {
  MenuAvailabilityService,
  type SupportedChannel,
  type DurationPreset,
} from "./menu-availability.service";
import { CurrentUser } from "../../common/decorators/current-user.decorator";
import type { AuthenticatedUser } from "../auth/interfaces/jwt-payload.interface";

const CHANNELS: SupportedChannel[] = [
  "ONLINE",
  "POS",
  "JUST_EAT",
  "UBER_EATS",
  "DELIVEROO",
  "WHATSAPP",
  "HUBRISE",
  "ALL",
];
const DURATIONS: DurationPreset[] = [
  "1h",
  "2h",
  "4h",
  "6h",
  "12h",
  "until_tomorrow",
  "indefinite",
];

class SnoozeDto {
  @IsString() @IsIn(CHANNELS) channel!: SupportedChannel;
  @IsString() @IsOptional() @IsIn(DURATIONS) duration?: DurationPreset;
  @IsString() @IsOptional() @IsISO8601() customExpiresAt?: string;
  @IsString() @IsOptional() @MaxLength(200) snoozeReason?: string;
  @IsString() @IsOptional() locationId?: string;
}

class UnsnoozeDto {
  @IsString() @IsIn(CHANNELS) channel!: SupportedChannel;
  @IsString() @IsOptional() locationId?: string;
}

@ApiTags("inventory")
@Controller({ path: "menu-availability", version: "1" })
export class MenuAvailabilityController {
  constructor(private readonly svc: MenuAvailabilityService) {}

  @Get("brands/:brandId")
  @ApiOperation({
    summary:
      "Inventory matrix — items × channels with current snooze state. Pass ?locationId= for that location's view (its own snoozes overlay the global ones).",
  })
  getMatrix(
    @Param("brandId") brandId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Query("locationId") locationId?: string,
  ) {
    return this.svc.getBrandMatrix(brandId, user.tenantId, locationId || undefined);
  }

  @Get("locations/:locationId/item-snoozes")
  @ApiOperation({
    summary:
      'Item ids 86\'d entirely at this location (channel "ALL") — backs the products-tab availability toggle.',
  })
  async locationItemSnoozes(
    @Param("locationId") locationId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    const ids = await this.svc.getLocationAllChannelSnoozedItemIds(
      locationId,
      user.tenantId,
    );
    return { itemIds: Array.from(ids) };
  }

  @Post("items/:itemId/snooze")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      "Snooze an item for one channel (locationId scopes it to one location; channel ALL = every channel)",
  })
  snooze(
    @Param("itemId") itemId: string,
    @Body() dto: SnoozeDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.svc.snooze({
      itemId,
      tenantId: user.tenantId,
      userId: user.userId,
      channel: dto.channel,
      duration: dto.duration,
      customExpiresAt: dto.customExpiresAt,
      snoozeReason: dto.snoozeReason,
      locationId: dto.locationId,
    });
  }

  @Post("items/:itemId/unsnooze")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      "Restore an item for one channel (locationId restores just that location; falls back to clearing a global snooze)",
  })
  unsnooze(
    @Param("itemId") itemId: string,
    @Body() dto: UnsnoozeDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.svc.unsnooze({
      itemId,
      tenantId: user.tenantId,
      channel: dto.channel,
      locationId: dto.locationId,
    });
  }
}
