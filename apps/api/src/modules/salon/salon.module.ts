import { Module } from "@nestjs/common";
import { OrdersModule } from "../orders/orders.module";
import { PaymentsModule } from "../payments/payments.module";
import { SmsModule } from "../sms/sms.module";
import { SalonController } from "./salon.controller";
import { SalonPublicController } from "./salon-public.controller";
import { SalonCatalogService } from "./salon-catalog.service";
import { SalonBookingService } from "./salon-booking.service";
import { SalonCheckoutService } from "./salon-checkout.service";
import { SalonDepositService } from "./salon-deposit.service";
import { SalonNotifyService } from "./salon-notify.service";
import { SalonQueueService } from "./salon-queue.service";
import { SalonReportsService } from "./salon-reports.service";
import { SalonRemindersCron } from "./salon-reminders.cron";

// Barbers, hair and nail salons: the price list with durations, the team and
// their hours, the appointment diary, online booking with deposits, the
// walk-in queue, checkout through the till's payment screens, reminders and
// reports. Money flows through OrdersService/PaymentsService unchanged.
@Module({
  imports: [OrdersModule, PaymentsModule, SmsModule],
  controllers: [SalonController, SalonPublicController],
  providers: [
    SalonCatalogService,
    SalonBookingService,
    SalonCheckoutService,
    SalonDepositService,
    SalonNotifyService,
    SalonQueueService,
    SalonReportsService,
    SalonRemindersCron,
  ],
  exports: [SalonBookingService, SalonCatalogService, SalonQueueService],
})
export class SalonModule {}
