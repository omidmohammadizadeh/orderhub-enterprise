import { forwardRef, Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { OrdersModule } from "../../orders/orders.module";
import { CredentialEncryptionService } from "../credential-encryption.service";
import { GeocodingService } from "../../dispatch/geocoding.service";
import { YangoClientService } from "./yango-client.service";
import { YangoConfigService } from "./yango-config.service";
import { YangoDispatchService } from "./yango-dispatch.service";
import { YangoTrackingService } from "./yango-tracking.service";
import { YangoPollCron } from "./yango-poll.cron";
import { YangoController } from "./yango.controller";
import { YangoWebhookController } from "./yango-webhook.controller";

// Phase BK — Yango Delivery (UAE) courier dispatch. Mirrors JetGoModule; the
// extra provider is the poller, because Yango's callback is deprecated and
// polling claims/bulk_info is the documented way to follow a claim.
@Module({
  imports: [ConfigModule, forwardRef(() => OrdersModule)],
  controllers: [YangoController, YangoWebhookController],
  providers: [
    YangoClientService,
    YangoConfigService,
    YangoDispatchService,
    YangoTrackingService,
    YangoPollCron,
    CredentialEncryptionService,
    GeocodingService,
  ],
  exports: [YangoConfigService, YangoDispatchService],
})
export class YangoModule {}
