// Phase AW-14 — Menu Availability (86 board) REST endpoints.

import {
  Controller,
  Get,
  Post,
  Body,
  Param,
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
}

class UnsnoozeDto {
  @IsString() @IsIn(CHANNELS) channel!: SupportedChannel;
}

@ApiTags("inventory")
@Controller({ path: "menu-availability", version: "1" })
export class MenuAvailabilityController {
  constructor(private readonly svc: MenuAvailabilityService) {}

  @Get("brands/:brandId")
  @ApiOperation({
    summary: "Inventory matrix — items × channels with current snooze state",
  })
  getMatrix(
    @Param("brandId") brandId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.svc.getBrandMatrix(brandId, user.tenantId);
  }

  @Post("items/:itemId/snooze")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Snooze an item for one channel" })
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
    });
  }

  @Post("items/:itemId/unsnooze")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Restore an item for one channel" })
  unsnooze(
    @Param("itemId") itemId: string,
    @Body() dto: UnsnoozeDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.svc.unsnooze({
      itemId,
      tenantId: user.tenantId,
      channel: dto.channel,
    });
  }
}
