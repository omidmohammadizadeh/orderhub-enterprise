import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { AuthModule } from "../../auth/auth.module";
import { IntegrationsModule } from "../integrations.module";
import { OrdersModule } from "../../orders/orders.module";
import { UberEatsClientService } from "./ubereats-client.service";
import { UberEatsOauthService } from "./ubereats-oauth.service";
import { UberEatsConnectionService } from "./ubereats-connection.service";
import { UberEatsMenuPublishService } from "./ubereats-menu-publish.service";
import { UberEatsOrderService } from "./ubereats-order.service";
import { UberEatsOrderSyncService } from "./ubereats-order-sync.service";
import { UberEatsOrderActionsService } from "./ubereats-order-actions.service";
import { UberEatsPromotionsService } from "./ubereats-promotions.service";
import { UberEatsController } from "./ubereats.controller";
import { UberEatsWebhookController } from "./ubereats-webhook.controller";

// Phase UE — Uber Eats DIRECT integration (off HubRise). OAuth client +
// webhook receiver (UE-1), merchant OAuth + store provisioning + store
// control (UE-2). Menu publish (UE-3) and the order flow (UE-4) extend this
// module the same way DeliverooModule grew.
//
// AuthModule provides the JwtService that signs/verifies the OAuth state
// param; IntegrationsModule provides CredentialEncryptionService for the
// stored merchant-token envelope.
@Module({
  // OrdersModule is a one-way import (nothing in Orders reaches back into
  // UberEats — the outbound sync listens to the order.status_changed event),
  // so no forwardRef is needed, same as DeliverooModule.
  imports: [ConfigModule, AuthModule, IntegrationsModule, OrdersModule],
  controllers: [UberEatsController, UberEatsWebhookController],
  providers: [
    UberEatsClientService,
    UberEatsOauthService,
    UberEatsConnectionService,
    UberEatsMenuPublishService,
    UberEatsOrderService,
    UberEatsOrderSyncService,
    UberEatsOrderActionsService,
    UberEatsPromotionsService,
  ],
  exports: [
    UberEatsClientService,
    UberEatsOauthService,
    UberEatsConnectionService,
    UberEatsMenuPublishService,
    UberEatsPromotionsService,
  ],
})
export class UberEatsModule {}
