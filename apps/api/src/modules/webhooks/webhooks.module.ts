import { Module, forwardRef } from "@nestjs/common";
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
  // Phase AU — OrdersModule now imports HubRiseModule (for status
  // push-back), and HubRiseModule imports WebhooksModule (for
  // canonical ingestion). That introduces a 3-hop cycle:
  //   OrdersModule → HubRiseModule → WebhooksModule → OrdersModule
  // Nest's module scanner can't resolve it without forwardRef on both
  // sides of the cycle, so wrap OrdersModule here too.
  imports: [forwardRef(() => OrdersModule)],
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
  // Export ingestion so the HubRise module's global webhook receiver
  // can dispatch into it without duplicating the adapter + signature
  // + idempotency chain.
  exports: [WebhookIngestionService],
})
export class WebhooksModule {}
