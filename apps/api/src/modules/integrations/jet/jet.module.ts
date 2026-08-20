import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { VariantPriceResolverModule } from "../../menus/variant-price-resolver.module";
import { OrdersModule } from "../../orders/orders.module";
import { CredentialEncryptionService } from "../credential-encryption.service";
import { JetClientService } from "./jet-client.service";
import { JetConnectionService } from "./jet-connection.service";
import { JetCredentialResolver } from "./jet-credential.resolver";
import { JetOrderAckService } from "./jet-order-ack.service";
import { JetOrderService } from "./jet-order.service";
import { JetLifecycleService } from "./jet-lifecycle.service";
import { JetMenuPublishService } from "./jet-menu-publish.service";
import { JetItemAvailabilityService } from "./jet-item-availability.service";
import { JetStoreStatusService } from "./jet-store-status.service";
import { JetController } from "./jet.controller";
import { JetWebhookController } from "./jet-webhook.controller";
import { JetLifecycleController } from "./jet-lifecycle.controller";

// Phase JE — direct Just Eat Takeaway (JET Connect) integration.
//
// JE-0 foundation (client, credential resolution, per-brand connection),
// JE-1 order intake (webhook receiver → ingestCanonical → async ack) and
// JE-2 lifecycle webhooks (cancel, driver status, store status, failed order)
// JE-3 menu publish + its asynchronous ingest callback, JE-4 item
// availability (86) and JE-5 store status / service times.
//
// OrdersModule is a one-way import — nothing in Orders reaches back into JET —
// so no forwardRef is needed, matching DeliverooModule. ActivityLogService
// comes from the @Global() LogsModule and is injected @Optional(), so unit
// tests can construct these services by hand.
@Module({
  imports: [ConfigModule, OrdersModule, VariantPriceResolverModule],
  controllers: [JetController, JetWebhookController, JetLifecycleController],
  providers: [
    CredentialEncryptionService,
    JetCredentialResolver,
    JetClientService,
    JetConnectionService,
    JetOrderService,
    JetOrderAckService,
    JetLifecycleService,
    JetMenuPublishService,
    JetItemAvailabilityService,
    JetStoreStatusService,
  ],
  exports: [
    JetClientService,
    JetCredentialResolver,
    JetConnectionService,
    JetMenuPublishService,
    JetItemAvailabilityService,
    JetStoreStatusService,
  ],
})
export class JetModule {}
