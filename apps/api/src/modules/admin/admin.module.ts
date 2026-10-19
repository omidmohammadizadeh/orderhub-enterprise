import { Module } from "@nestjs/common";
import { BullModule } from "@nestjs/bull";
import { QUEUES } from "@orderhub/shared";
import { AdminController } from "./admin.controller";
import { DashboardAccessController } from "./dashboard-access.controller";
import { DispatchChargingController } from "./dispatch-charging.controller";
import {
  PublicWebsiteShowcaseController,
  WebsiteShowcaseController,
} from "./website-showcase.controller";
import { AdminService } from "./admin.service";
import { DashboardAccessService } from "./dashboard-access.service";
import { DispatchChargingService } from "./dispatch-charging.service";
import { WebsiteShowcaseService } from "./website-showcase.service";
import { PublicSocialLoginController, SocialLoginController } from "./social-login.controller";
import { SocialLoginService } from "./social-login.service";
import { DatabaseModule } from "../../infrastructure/database/database.module";

@Module({
  imports: [
    DatabaseModule,
    BullModule.registerQueue(
      { name: QUEUES.ORDER_PROCESSING },
      { name: QUEUES.ORDER_SYNC },
      { name: QUEUES.PRINTING },
    ),
  ],
  controllers: [
    AdminController,
    DashboardAccessController,
    DispatchChargingController,
    WebsiteShowcaseController,
    PublicWebsiteShowcaseController,
    SocialLoginController,
    PublicSocialLoginController,
  ],
  providers: [
    AdminService,
    DashboardAccessService,
    DispatchChargingService,
    WebsiteShowcaseService,
    SocialLoginService,
  ],
})
export class AdminModule {}
