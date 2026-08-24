import { Module } from "@nestjs/common";
import { LoyaltyService } from "./loyalty.service";
import { ReferralService } from "./referral.service";
import { LoyaltyController } from "./loyalty.controller";

// Stamp cards. Listens on order.status_changed rather than being called by
// Orders, which keeps the dependency one-way: a loyalty scheme failing can
// never roll back a kitchen state that staff can already see.
@Module({
  controllers: [LoyaltyController],
  providers: [LoyaltyService, ReferralService],
  exports: [LoyaltyService, ReferralService],
})
export class LoyaltyModule {}
