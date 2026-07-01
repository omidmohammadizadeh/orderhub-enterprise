import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { DeliverooClientService } from "./deliveroo-client.service";

// Phase BA — Deliveroo direct integration. Foundation module: the OAuth
// client + webhook-signature verifier. Connection, orders webhook, outbound
// status, and menu publish services land here in later phases.
@Module({
  imports: [ConfigModule],
  providers: [DeliverooClientService],
  exports: [DeliverooClientService],
})
export class DeliverooModule {}
