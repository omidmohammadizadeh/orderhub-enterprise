import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { PayoutsModule } from "../payouts/payouts.module";
import { PaymentsController } from "./payments.controller";
import { PaymentsService } from "./payments.service";
import { TerminalController } from "./terminal.controller";
import { TerminalService } from "./terminal.service";
import { ReceiptEmailService } from "./receipt-email.service";
import { TapService } from "./tap.service";

@Module({
  imports: [ConfigModule, PayoutsModule],
  controllers: [PaymentsController, TerminalController],
  providers: [PaymentsService, TerminalService, ReceiptEmailService, TapService],
  exports: [PaymentsService, TerminalService, ReceiptEmailService, TapService],
})
export class PaymentsModule {}
