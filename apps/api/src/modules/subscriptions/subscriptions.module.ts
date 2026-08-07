import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { SubscriptionsService } from "./subscriptions.service";
import { SubscriptionsController } from "./subscriptions.controller";
import { SubscriptionAlertEmailService } from "./subscription-alert-email.service";
import { PrismaService } from "../../infrastructure/database/prisma.service";

@Module({
  imports: [ConfigModule],
  controllers: [SubscriptionsController],
  providers: [SubscriptionsService, SubscriptionAlertEmailService, PrismaService],
  exports: [SubscriptionsService],
})
export class SubscriptionsModule {}
