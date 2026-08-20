import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { OrdersModule } from "../../orders/orders.module";
import { CredentialEncryptionService } from "../credential-encryption.service";
import { JetClientService } from "./jet-client.service";
import { JetConnectionService } from "./jet-connection.service";
import { JetCredentialResolver } from "./jet-credential.resolver";
import { JetOrderAckService } from "./jet-order-ack.service";
import { JetOrderService } from "./jet-order.service";
import { JetController } from "./jet.controller";
import { JetWebhookController } from "./jet-webhook.controller";

// Phase JE — direct Just Eat Takeaway (JET Connect) integration.
//
// JE-0 foundation (client, credential resolution, per-brand connection) and
// JE-1 order intake (webhook receiver → ingestCanonical → async ack).
//
// OrdersModule is a one-way import — nothing in Orders reaches back into JET —
// so no forwardRef is needed, matching DeliverooModule. ActivityLogService
// comes from the @Global() LogsModule and is injected @Optional(), so unit
// tests can construct these services by hand.
@Module({
  imports: [ConfigModule, OrdersModule],
  controllers: [JetController, JetWebhookController],
  providers: [
    CredentialEncryptionService,
    JetCredentialResolver,
    JetClientService,
    JetConnectionService,
    JetOrderService,
    JetOrderAckService,
  ],
  exports: [JetClientService, JetCredentialResolver, JetConnectionService],
})
export class JetModule {}
