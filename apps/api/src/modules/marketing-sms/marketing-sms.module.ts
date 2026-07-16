import { Module } from "@nestjs/common";
import { MarketingSmsService } from "./marketing-sms.service";
import { MarketingSmsController } from "./marketing-sms.controller";

// SmsService + WalletService are @Global (SmsModule / WalletModule) so no
// imports are needed here.
@Module({
  controllers: [MarketingSmsController],
  providers: [MarketingSmsService],
  exports: [MarketingSmsService],
})
export class MarketingSmsModule {}
