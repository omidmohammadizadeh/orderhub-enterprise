import { Module } from "@nestjs/common";
import { EmailCampaignSenderService } from "./email-campaign-sender.service";
import {
  EmailMarketingController,
  EmailMarketingPublicController,
} from "./email-marketing.controller";
import { EmailMarketingService } from "./email-marketing.service";

// EmailService + WalletService are @Global, so nothing to import here.
@Module({
  controllers: [EmailMarketingController, EmailMarketingPublicController],
  providers: [EmailMarketingService, EmailCampaignSenderService],
  exports: [EmailMarketingService],
})
export class EmailMarketingModule {}
