import { Global, Module } from "@nestjs/common";
import { SmsService } from "./sms.service";

// Global so any module (payments, marketing, …) can inject SmsService without
// re-importing — mirrors the ExpoPushModule pattern.
@Global()
@Module({
  providers: [SmsService],
  exports: [SmsService],
})
export class SmsModule {}
