import { Module } from "@nestjs/common";
import { WebhooksController } from "./webhooks.controller";
import { WebhookIngestionService } from "./webhook-ingestion.service";
import { WebhookAdapterFactory } from "./webhook-adapter.factory";
import { UberEatsAdapter } from "./adapters/uber-eats.adapter";
import { DeliverooAdapter } from "./adapters/deliveroo.adapter";
import { JustEatAdapter } from "./adapters/just-eat.adapter";
import { HubRiseAdapter } from "./adapters/hubrise.adapter";
import { CredentialEncryptionService } from "../integrations/credential-encryption.service";
import { OrdersModule } from "../orders/orders.module";

@Module({
  imports: [OrdersModule],
  controllers: [WebhooksController],
  providers: [
    WebhookIngestionService,
    WebhookAdapterFactory,
    CredentialEncryptionService,
    UberEatsAdapter,
    DeliverooAdapter,
    JustEatAdapter,
    HubRiseAdapter,
  ],
})
export class WebhooksModule {}
