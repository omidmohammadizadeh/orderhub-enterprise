import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { DeliverooClientService } from "./deliveroo-client.service";
import { DeliverooConnectionService } from "./deliveroo-connection.service";
import { DeliverooOrderService } from "./deliveroo-order.service";
import { DeliverooController } from "./deliveroo.controller";
import { DeliverooWebhookController } from "./deliveroo-webhook.controller";
import { OrdersModule } from "../../orders/orders.module";
import { DeliverooAdapter } from "../../webhooks/adapters/deliveroo.adapter";

// Phase BA — Deliveroo direct integration. OAuth client + webhook verifier
// (BA-1), per-brand connection + store control (BA-2), the inbound webhook
// receiver (BA-3a: connectivity + signature), and order routing into
// OrdersService.ingestCanonical / updateStatus (BA-3b).
//
// OrdersModule is a one-way import (nothing in Orders reaches back into
// Deliveroo), so no forwardRef is needed. DeliverooAdapter is a pure,
// dependency-free normaliser reused from the webhooks module for order
// payload parsing.
@Module({
  imports: [ConfigModule, OrdersModule],
  controllers: [DeliverooController, DeliverooWebhookController],
  providers: [
    DeliverooClientService,
    DeliverooConnectionService,
    DeliverooOrderService,
    DeliverooAdapter,
  ],
  exports: [DeliverooClientService, DeliverooConnectionService],
})
export class DeliverooModule {}
