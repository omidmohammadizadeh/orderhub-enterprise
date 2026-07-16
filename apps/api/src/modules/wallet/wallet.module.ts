import { Global, Module } from "@nestjs/common";
import { WalletService } from "./wallet.service";
import { WalletController } from "./wallet.controller";

// Global so SmsService (billable-send gating/debit) and PaymentsService
// (top-up webhook credit) can inject WalletService without module import
// cycles — mirrors SmsModule.
@Global()
@Module({
  controllers: [WalletController],
  providers: [WalletService],
  exports: [WalletService],
})
export class WalletModule {}
