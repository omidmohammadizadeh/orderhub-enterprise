import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { PaymentsController } from "./payments.controller";
import { PaymentsService } from "./payments.service";
import { TerminalController } from "./terminal.controller";
import { TerminalService } from "./terminal.service";
import { ReceiptEmailService } from "./receipt-email.service";

@Module({
  imports: [ConfigModule],
  controllers: [PaymentsController, TerminalController],
  providers: [PaymentsService, TerminalService, ReceiptEmailService],
  exports: [PaymentsService, TerminalService, ReceiptEmailService],
})
export class PaymentsModule {}
