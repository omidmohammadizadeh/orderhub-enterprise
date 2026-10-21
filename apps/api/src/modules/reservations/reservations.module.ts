import { Module } from "@nestjs/common";
import { ReservationsController } from "./reservations.controller";
import { ReservationsService } from "./reservations.service";
import { ReservationEmailService } from "./reservation-email.service";

@Module({
  controllers: [ReservationsController],
  providers: [ReservationsService, ReservationEmailService],
  exports: [ReservationsService],
})
export class ReservationsModule {}
