import { Module } from "@nestjs/common";
import { BullModule } from "@nestjs/bull";
import { QUEUES } from "@orderhub/shared";
import { WebhooksController } from "./webhooks.controller";
import { WebhookIngestionService } from "./webhook-ingestion.service";
import { UberEatsAdapter } from "./adapters/uber-eats.adapter";
import { DeliverooAdapter } from "./adapters/deliveroo.adapter";
import { JustEatAdapter } from "./adapters/just-eat.adapter";
import { HubRiseAdapter } from "./adapters/hubrise.adapter";
import { OrdersModule } from "../orders/orders.module";

@Module({
  imports: [
    BullModule.registerQueue({ name: QUEUES.WEBHOOK_DISPATCH }),
    OrdersModule,
  ],
  controllers: [WebhooksController],
  providers: [
    WebhookIngestionService,
    UberEatsAdapter,
    DeliverooAdapter,
    JustEatAdapter,
    HubRiseAdapter,
  ],
})
export class WebhooksModule {}
