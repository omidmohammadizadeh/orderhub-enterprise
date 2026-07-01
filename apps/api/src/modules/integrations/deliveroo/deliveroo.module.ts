import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { DeliverooClientService } from "./deliveroo-client.service";
import { DeliverooConnectionService } from "./deliveroo-connection.service";
import { DeliverooController } from "./deliveroo.controller";
import { DeliverooWebhookController } from "./deliveroo-webhook.controller";

// Phase BA — Deliveroo direct integration. OAuth client + webhook verifier
// (BA-1), per-brand connection + store control (BA-2), and the inbound webhook
// receiver (BA-3a: connectivity + signature; order routing lands in BA-3b).
@Module({
  imports: [ConfigModule],
  controllers: [DeliverooController, DeliverooWebhookController],
  providers: [DeliverooClientService, DeliverooConnectionService],
  exports: [DeliverooClientService, DeliverooConnectionService],
})
export class DeliverooModule {}
