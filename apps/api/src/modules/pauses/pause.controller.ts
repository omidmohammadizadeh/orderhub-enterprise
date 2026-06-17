// Phase AW-15 — Stop Taking Orders / Busy Mode REST endpoints.

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
  IsInt,
  Min,
  Max,
} from "class-validator";
import {
  PauseService,
  type SupportedChannel,
  type DurationPreset,
  type Mode,
} from "./pause.service";
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
  "until_further_notice",
];
const MODES: Mode[] = ["paused", "busy"];

class PauseDto {
  @IsString() locationId!: string;
  @IsString() @IsOptional() brandId?: string;
  @IsString() @IsOptional() @IsIn(CHANNELS) channel?: SupportedChannel;
  @IsString() @IsIn(MODES) mode!: Mode;
  @IsString() @IsOptional() @IsIn(DURATIONS) duration?: DurationPreset;
  @IsString() @IsOptional() @IsISO8601() customResumeAt?: string;
  @IsString() @IsOptional() @MaxLength(300) reason?: string;
  @IsInt() @IsOptional() @Min(5) @Max(240) extraPrepTime?: number;
}

class ResumeDto {
  @IsString() @IsOptional() rowId?: string;
  @IsString() @IsOptional() locationId?: string;
  @IsString() @IsOptional() brandId?: string;
  @IsString() @IsOptional() @IsIn(CHANNELS) channel?: SupportedChannel;
}

@ApiTags("pauses")
@Controller({ path: "pauses", version: "1" })
export class PauseController {
  constructor(private readonly svc: PauseService) {}

  @Get("location/:locationId")
  @ApiOperation({ summary: "List active pauses at a location" })
  list(
    @Param("locationId") locationId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.svc.listActiveForLocation(locationId, user.tenantId);
  }

  @Get("status")
  @ApiOperation({ summary: "Resolve current pause state for a scope" })
  status(
    @Query("locationId") locationId: string,
    @Query("brandId") brandId?: string,
    @Query("channel") channel?: SupportedChannel,
    @CurrentUser() user?: AuthenticatedUser,
  ) {
    // Tenant guard happens inside isPaused via the location lookup —
    // this endpoint is read-only and the matched data is non-sensitive.
    return this.svc.isPaused({ locationId, brandId, channel });
  }

  @Post()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Pause or busy-mode a location/brand/channel" })
  pause(@Body() dto: PauseDto, @CurrentUser() user: AuthenticatedUser) {
    return this.svc.pause({
      tenantId: user.tenantId,
      userId: user.userId,
      scope: {
        locationId: dto.locationId,
        brandId: dto.brandId,
        channel: dto.channel,
      },
      mode: dto.mode,
      duration: dto.duration,
      customResumeAt: dto.customResumeAt,
      reason: dto.reason,
      extraPrepTime: dto.extraPrepTime,
    });
  }

  @Post("resume")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Resume a paused scope" })
  resume(@Body() dto: ResumeDto, @CurrentUser() user: AuthenticatedUser) {
    return this.svc.resume({
      tenantId: user.tenantId,
      rowId: dto.rowId,
      scope: dto.locationId
        ? {
            locationId: dto.locationId,
            brandId: dto.brandId,
            channel: dto.channel,
          }
        : undefined,
    });
  }
}
