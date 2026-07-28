import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
} from "@nestjs/common";
import { ApiTags, ApiOperation, ApiBearerAuth } from "@nestjs/swagger";
import {
  ReservationsService,
  type CreateReservationInput,
  type ReservationStatus,
} from "./reservations.service";
import { CurrentUser } from "../../common/decorators/current-user.decorator";
import { Roles } from "../../common/decorators/roles.decorator";
import { Public } from "../../common/decorators/public.decorator";
import type { AuthenticatedUser } from "../auth/interfaces/jwt-payload.interface";

// Table reservations. The diary is tenant-scoped (JWT); the storefront
// booking form is @Public() and keyed only by locationId, gated on the
// location having table service AND online reservations switched on.
//
// Role lists carry BOTH legacy names and the newer Team-Roles, same as
// tables.controller.ts — front-of-house takes bookings, so OPERATE is
// deliberately wide.
const MANAGE = [
  "PLATFORM_ADMIN",
  "TENANT_OWNER",
  "OWNER",
  "MANAGER",
  "DARK_KITCHEN_MANAGER",
] as const;
const OPERATE = [...MANAGE, "CASHIER", "STAFF"] as const;

@ApiTags("reservations")
@Controller({ path: "reservations", version: "1" })
export class ReservationsController {
  constructor(private readonly reservations: ReservationsService) {}

  // ── Public storefront ───────────────────────────────────────────────

  @Get("public/settings")
  @Public()
  @ApiOperation({ summary: "Is this location taking online bookings?" })
  publicSettings(@Query("locationId") locationId: string) {
    return this.reservations.settingsFor(locationId);
  }

  @Get("public/availability")
  @Public()
  @ApiOperation({ summary: "Free slots for a party (guest-facing)" })
  async publicAvailability(
    @Query("locationId") locationId: string,
    @Query("startsAt") startsAt: string,
    @Query("partySize") partySize: string,
    @Query("durationMins") durationMins?: string,
  ) {
    const settings = await this.reservations.settingsFor(locationId);
    const res = await this.reservations.availability(
      locationId,
      new Date(startsAt),
      Number(partySize) || 2,
      Number(durationMins) || settings.slotMinutes,
      { onlineOnly: true },
    );
    // The guest only needs to know IF there's room, never which tables
    // exist or what they're called.
    return {
      startsAt: res.startsAt,
      partySize: res.partySize,
      available: res.available.length > 0,
      seatsLeft: res.available.length,
    };
  }

  @Post("public")
  @Public()
  @ApiOperation({ summary: "Book a table from the storefront" })
  createPublic(@Body() body: CreateReservationInput) {
    return this.reservations.createPublic(body);
  }

  // ── Staff diary ─────────────────────────────────────────────────────

  @Get()
  @ApiBearerAuth()
  @Roles(...OPERATE)
  @ApiOperation({ summary: "List reservations for a day / range" })
  list(
    @CurrentUser() user: AuthenticatedUser,
    @Query("locationId") locationId?: string,
    @Query("from") from?: string,
    @Query("to") to?: string,
    @Query("status") status?: string,
  ) {
    return this.reservations.list(user.tenantId, {
      locationId,
      from,
      to,
      status,
    });
  }

  @Get("availability")
  @ApiBearerAuth()
  @Roles(...OPERATE)
  @ApiOperation({ summary: "Which tables are free for a party and time" })
  availability(
    @Query("locationId") locationId: string,
    @Query("startsAt") startsAt: string,
    @Query("partySize") partySize: string,
    @Query("durationMins") durationMins?: string,
    @Query("ignoreReservationId") ignoreReservationId?: string,
  ) {
    return this.reservations.availability(
      locationId,
      new Date(startsAt),
      Number(partySize) || 2,
      Number(durationMins) || 90,
      { ignoreReservationId },
    );
  }

  @Post()
  @ApiBearerAuth()
  @Roles(...OPERATE)
  @ApiOperation({ summary: "Take a booking" })
  create(
    @Body() body: CreateReservationInput,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.reservations.create(user.tenantId, body);
  }

  @Patch(":id")
  @ApiBearerAuth()
  @Roles(...OPERATE)
  @ApiOperation({ summary: "Edit a booking" })
  update(
    @Param("id") id: string,
    @Body() body: Partial<CreateReservationInput> & { status?: ReservationStatus },
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.reservations.update(user.tenantId, id, body);
  }

  @Post(":id/status")
  @ApiBearerAuth()
  @Roles(...OPERATE)
  @ApiOperation({ summary: "Confirm / cancel / no-show a booking" })
  setStatus(
    @Param("id") id: string,
    @Body() body: { status: ReservationStatus },
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.reservations.setStatus(user.tenantId, id, body.status);
  }

  @Post(":id/seat")
  @ApiBearerAuth()
  @Roles(...OPERATE)
  @ApiOperation({ summary: "The party arrived — seat them and open the tab" })
  seat(
    @Param("id") id: string,
    @Body() body: { tableId?: string },
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.reservations.seat(user.tenantId, id, body?.tableId);
  }

  @Delete(":id")
  @ApiBearerAuth()
  @Roles(...MANAGE)
  @ApiOperation({ summary: "Delete a booking" })
  remove(@Param("id") id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.reservations.remove(user.tenantId, id);
  }
}
