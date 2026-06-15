import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { AuthModule } from "../../auth/auth.module";
import { WebhooksModule } from "../../webhooks/webhooks.module";
import { IntegrationsModule } from "../integrations.module";
import { HubRiseOauthController } from "./hubrise-oauth.controller";
import { HubRiseOauthService } from "./hubrise-oauth.service";

@Module({
  // ConfigModule for app config, AuthModule for the JwtService used to
  // sign + verify the OAuth state param, IntegrationsModule for the
  // CredentialEncryptionService that writes the token envelope, and
  // WebhooksModule for the WebhookIngestionService that the global
  // HubRise webhook handler dispatches into.
  imports: [ConfigModule, AuthModule, IntegrationsModule, WebhooksModule],
  controllers: [HubRiseOauthController],
  providers: [HubRiseOauthService],
  exports: [HubRiseOauthService],
})
export class HubRiseModule {}
