import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { CareemClientService } from "./careem-client.service";
import { CareemController } from "./careem.controller";
import { CareemWebhookController } from "./careem-webhook.controller";
import { CareemWebhookLogService } from "./careem-webhook-log.service";

// Phase CA — direct Careem (Now/SuperApp) POS integration.
//
// CA-0 transport: OAuth2 client_credentials against Careem's identity service,
// token caching, and the authenticated request helper.
// CA-1 webhook receiver: one endpoint, four event types, static-key auth.
//
// Deliberately NOT importing OrdersModule yet. Nothing here creates an order
// until the transformer is written against a real payload rather than the
// spec's examples — the same rule that left the JET transformer honest about
// being spec-derived.
@Module({
  imports: [ConfigModule],
  controllers: [CareemController, CareemWebhookController],
  providers: [CareemClientService, CareemWebhookLogService],
  exports: [CareemClientService],
})
export class CareemModule {}
