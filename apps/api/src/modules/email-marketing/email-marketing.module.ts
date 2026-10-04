import { Module } from "@nestjs/common";
import { PromoCodesModule } from "../promo-codes/promo-codes.module";
import { EmailCampaignSenderService } from "./email-campaign-sender.service";
import {
  EmailMarketingController,
  EmailMarketingPublicController,
} from "./email-marketing.controller";
import { EmailMarketingService } from "./email-marketing.service";

// EmailService + WalletService are @Global, so nothing to import here.
@Module({
  // Offers create real promo codes (one use per customer by default).
  imports: [PromoCodesModule],
  controllers: [EmailMarketingController, EmailMarketingPublicController],
  providers: [EmailMarketingService, EmailCampaignSenderService],
  exports: [EmailMarketingService],
})
export class EmailMarketingModule {}
