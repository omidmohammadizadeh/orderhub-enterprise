import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { AuthModule } from "../../auth/auth.module";
import { IntegrationsModule } from "../integrations.module";
import { HubRiseOauthController } from "./hubrise-oauth.controller";
import { HubRiseOauthService } from "./hubrise-oauth.service";

@Module({
  // ConfigModule for app config, AuthModule for the JwtService used to
  // sign + verify the OAuth state param, IntegrationsModule for the
  // CredentialEncryptionService that writes the token envelope.
  imports: [ConfigModule, AuthModule, IntegrationsModule],
  controllers: [HubRiseOauthController],
  providers: [HubRiseOauthService],
  exports: [HubRiseOauthService],
})
export class HubRiseModule {}
