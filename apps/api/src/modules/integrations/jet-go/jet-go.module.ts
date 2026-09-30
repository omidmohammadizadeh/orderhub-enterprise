import { forwardRef, Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { OrdersModule } from "../../orders/orders.module";
import { CredentialEncryptionService } from "../credential-encryption.service";
import { GeocodingService } from "../../dispatch/geocoding.service";
import { JetGoClientService } from "./jet-go-client.service";
import { JetGoConfigService } from "./jet-go-config.service";
import { JetGoDispatchService } from "./jet-go-dispatch.service";
import { JetGoWebhookService } from "./jet-go-webhook.service";
import { JetGoController } from "./jet-go.controller";
import { JetGoWebhookController } from "./jet-go-webhook.controller";

// Phase BJ — JET Go (Just Eat Takeaway Delivery-as-a-Service) courier dispatch.
// Mirrors UberDirectModule; WalletService is @Global, the webhook bumps order
// status through OrdersService, ActivityLogService comes from the @Global
// LogsModule, and GeocodingService is provided directly rather than importing
// DispatchModule (which would pull in the whole dispatch console).
@Module({
  imports: [ConfigModule, forwardRef(() => OrdersModule)],
  controllers: [JetGoController, JetGoWebhookController],
  providers: [
    JetGoClientService,
    JetGoConfigService,
    JetGoDispatchService,
    JetGoWebhookService,
    CredentialEncryptionService,
    GeocodingService,
  ],
  exports: [JetGoConfigService, JetGoDispatchService],
})
export class JetGoModule {}
