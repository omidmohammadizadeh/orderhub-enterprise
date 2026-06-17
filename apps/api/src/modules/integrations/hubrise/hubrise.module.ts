import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { AuthModule } from "../../auth/auth.module";
import { WebhooksModule } from "../../webhooks/webhooks.module";
import { IntegrationsModule } from "../integrations.module";
import { HubRiseOauthController } from "./hubrise-oauth.controller";
import { HubRiseOauthService } from "./hubrise-oauth.service";
import { HubRiseOrderSyncService } from "./hubrise-order-sync.service";
import { HubRiseDeliverySyncService } from "./hubrise-delivery-sync.service";
import { HubRiseCatalogService } from "./hubrise-catalog.service";
import { HubRiseLocationPauseService } from "./hubrise-location-pause.service";
import { OrdersModule } from "../../orders/orders.module";
import { forwardRef } from "@nestjs/common";

@Module({
  // ConfigModule for app config, AuthModule for the JwtService used to
  // sign + verify the OAuth state param, IntegrationsModule for the
  // CredentialEncryptionService that writes the token envelope, and
  // WebhooksModule for the WebhookIngestionService that the global
  // HubRise webhook handler dispatches into.
  imports: [
    ConfigModule,
    AuthModule,
    IntegrationsModule,
    WebhooksModule,
    // OrdersModule provides OrdersService for the delivery-sync
    // handler to call updateStatus(actorType="WEBHOOK"). It's a
    // circular dep — OrdersService → HubRiseOrderSyncService for
    // the outbound push, and HubRiseDeliverySyncService → OrdersService
    // for the inbound courier-driven transitions. forwardRef breaks
    // the loop the same way it does for WebhooksModule above.
    forwardRef(() => OrdersModule),
  ],
  controllers: [HubRiseOauthController],
  providers: [
    HubRiseOauthService,
    HubRiseOrderSyncService,
    HubRiseDeliverySyncService,
    HubRiseCatalogService,
    HubRiseLocationPauseService,
  ],
  // HubRiseOrderSyncService is consumed by OrdersService to push our
  // status transitions back to HubRise so every connected channel
  // (Uber Eats, Deliveroo, Just Eat) sees the same lifecycle.
  // HubRiseCatalogService is consumed by MenusService for the Phase
  // AW-11 import + publish endpoints exposed on /v1/menus.
  exports: [
    HubRiseOauthService,
    HubRiseOrderSyncService,
    HubRiseCatalogService,
    HubRiseLocationPauseService,
  ],
})
export class HubRiseModule {}
