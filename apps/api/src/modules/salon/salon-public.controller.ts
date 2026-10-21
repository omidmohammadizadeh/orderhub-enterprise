import { Body, Controller, Get, Param, Post, Query } from "@nestjs/common";
import { ApiOperation, ApiTags } from "@nestjs/swagger";
import { Throttle } from "@nestjs/throttler";
import { Public } from "../../common/decorators/public.decorator";
import { SalonBookingService, type BookInput } from "./salon-booking.service";
import { SalonQueueService } from "./salon-queue.service";
import { SalonDepositService } from "./salon-deposit.service";
import { parseServices } from "./salon.controller";

// The guest side: the booking page, the manage-my-booking link, the walk-in
// queue on a phone and the TV by the door. No login — keyed by locationId
// (public anyway: it's in the shop's booking URL) or by an unguessable token.

@ApiTags("salon-public")
@Controller({ path: "salon/public", version: "1" })
export class SalonPublicController {
  constructor(
    private readonly booking: SalonBookingService,
    private readonly queue: SalonQueueService,
    private readonly deposits: SalonDepositService,
  ) {}

  @Get("shop/:locationId")
  @Public()
  @ApiOperation({ summary: "Shop, price list and team for the booking page" })
  shop(@Param("locationId") locationId: string) {
    return this.booking.publicShop(locationId);
  }

  @Get("shop/:locationId/slots")
  @Public()
  slots(
    @Param("locationId") locationId: string,
    @Query("date") date: string,
    @Query("services") services: string,
    @Query("staffId") staffId?: string,
  ) {
    return this.booking.availability({
      locationId,
      date,
      services: parseServices(services),
      staffId: staffId || "any",
      online: true,
    });
  }

  @Get("shop/:locationId/days")
  @Public()
  // Up to 31 availability runs per call — keep it from being a cheap DB load.
  @Throttle({ short: { ttl: 60_000, limit: 30 }, medium: { ttl: 60_000, limit: 30 } })
  days(
    @Param("locationId") locationId: string,
    @Query("from") from: string,
    @Query("days") days: string,
    @Query("services") services: string,
    @Query("staffId") staffId?: string,
  ) {
    return this.booking.availableDays({
      locationId,
      from,
      days: Number(days) || 14,
      services: parseServices(services),
      staffId: staffId || "any",
    });
  }

  @Post("shop/:locationId/book")
  @Public()
  @Throttle({ short: { ttl: 60_000, limit: 10 }, medium: { ttl: 60_000, limit: 10 } })
  book(@Param("locationId") locationId: string, @Body() body: BookInput) {
    return this.booking.bookOnline({ ...body, locationId });
  }

  // ── Manage my booking ───────────────────────────────────────────────

  @Get("booking/:token")
  @Public()
  view(@Param("token") token: string) {
    return this.booking.publicView(token);
  }

  @Post("booking/:token/cancel")
  @Public()
  cancel(@Param("token") token: string) {
    return this.booking.cancelByGuest(token);
  }

  @Get("booking/:token/slots")
  @Public()
  rescheduleSlots(@Param("token") token: string, @Query("date") date: string) {
    return this.booking.guestRescheduleSlots(token, date);
  }

  @Post("booking/:token/reschedule")
  @Public()
  reschedule(@Param("token") token: string, @Body() body: { startsAt: string; staffId?: string }) {
    return this.booking.rescheduleByGuest(token, body);
  }

  @Post("booking/:token/pay")
  @Public()
  pay(@Param("token") token: string) {
    return this.deposits.resume(token);
  }

  // ── Walk-in queue ───────────────────────────────────────────────────

  @Get("queue/:locationId")
  @Public()
  board(@Param("locationId") locationId: string) {
    return this.queue.publicBoard(locationId);
  }

  @Post("queue/:locationId/join")
  @Public()
  @Throttle({ short: { ttl: 60_000, limit: 20 }, medium: { ttl: 60_000, limit: 20 } })
  async join(
    @Param("locationId") locationId: string,
    @Body() body: { customerName: string; customerPhone?: string; serviceIds?: string[]; preferredStaffId?: string },
  ) {
    const { entry, already } = await this.queue.join({ ...body, locationId }, { source: "ONLINE" });
    return { token: entry.publicToken, already };
  }

  @Get("queue/ticket/:token")
  @Public()
  ticket(@Param("token") token: string) {
    return this.queue.publicStatus(token);
  }

  @Post("queue/ticket/:token/leave")
  @Public()
  leave(@Param("token") token: string) {
    return this.queue.publicLeave(token);
  }
}
