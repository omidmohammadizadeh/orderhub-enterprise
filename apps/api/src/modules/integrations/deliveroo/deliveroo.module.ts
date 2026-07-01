import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { DeliverooClientService } from "./deliveroo-client.service";
import { DeliverooConnectionService } from "./deliveroo-connection.service";
import { DeliverooController } from "./deliveroo.controller";

// Phase BA — Deliveroo direct integration. OAuth client + webhook verifier
// (BA-1) and per-brand connection + store control (BA-2). Orders webhook,
// outbound status, and menu publish land in later phases.
@Module({
  imports: [ConfigModule],
  controllers: [DeliverooController],
  providers: [DeliverooClientService, DeliverooConnectionService],
  exports: [DeliverooClientService, DeliverooConnectionService],
})
export class DeliverooModule {}
