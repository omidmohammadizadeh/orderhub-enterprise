import { Module } from "@nestjs/common";
import { LoyaltyService } from "./loyalty.service";
import { ReferralService } from "./referral.service";
import { LoyaltyController } from "./loyalty.controller";
import { ApplePassService } from "./walk-in/apple-pass.service";
import { GoogleWalletService } from "./walk-in/google-wallet.service";
import { PassKitController } from "./walk-in/passkit.controller";
import { WalkInLoyaltyController } from "./walk-in/walk-in.controller";
import { WalkInLoyaltyService } from "./walk-in/walk-in-loyalty.service";

// Stamp cards. Listens on order.status_changed rather than being called by
// Orders, which keeps the dependency one-way: a loyalty scheme failing can
// never roll back a kitchen state that staff can already see.
@Module({
  controllers: [LoyaltyController, WalkInLoyaltyController, PassKitController],
  providers: [LoyaltyService, ReferralService, WalkInLoyaltyService, ApplePassService, GoogleWalletService],
  exports: [LoyaltyService, ReferralService, WalkInLoyaltyService],
})
export class LoyaltyModule {}
