import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { BillingController } from "./billing.controller";
import { BillingService } from "./billing.service";
import { BillingCron } from "./billing.cron";
import { PlanLimitsService } from "./plan-limits.service";
import { StripeService } from "./stripe.service";
import { StripeWebhookController } from "./stripe-webhook.controller";
import { UsageService } from "./usage.service";
import { PrismaService } from "../../infrastructure/database/prisma.service";
import { SubscriptionsModule } from "../subscriptions/subscriptions.module";
import { PaymentsModule } from "../payments/payments.module";

@Module({
  // PaymentsModule: the /webhooks/stripe route Stripe posts to lives here, so
  // it must be able to forward connected-account payment events to
  // PaymentsService (markAuthorized etc.). PaymentsModule doesn't import
  // billing, so there's no circular dependency.
  imports: [ConfigModule, SubscriptionsModule, PaymentsModule],
  controllers: [BillingController, StripeWebhookController],
  providers: [
    StripeService,
    UsageService,
    PlanLimitsService,
    BillingCron,
    {
      provide: BillingService,
      useFactory: (prisma: PrismaService, stripe: StripeService) =>
        new BillingService(prisma, stripe),
      inject: [PrismaService, StripeService],
    },
  ],
  exports: [BillingService, StripeService, UsageService, PlanLimitsService],
})
export class BillingModule {}
