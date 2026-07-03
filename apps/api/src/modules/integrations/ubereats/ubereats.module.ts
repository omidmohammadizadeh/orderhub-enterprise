import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { AuthModule } from "../../auth/auth.module";
import { IntegrationsModule } from "../integrations.module";
import { UberEatsClientService } from "./ubereats-client.service";
import { UberEatsOauthService } from "./ubereats-oauth.service";
import { UberEatsConnectionService } from "./ubereats-connection.service";
import { UberEatsMenuPublishService } from "./ubereats-menu-publish.service";
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
  imports: [ConfigModule, AuthModule, IntegrationsModule],
  controllers: [UberEatsController, UberEatsWebhookController],
  providers: [
    UberEatsClientService,
    UberEatsOauthService,
    UberEatsConnectionService,
    UberEatsMenuPublishService,
  ],
  exports: [
    UberEatsClientService,
    UberEatsOauthService,
    UberEatsConnectionService,
    UberEatsMenuPublishService,
  ],
})
export class UberEatsModule {}
