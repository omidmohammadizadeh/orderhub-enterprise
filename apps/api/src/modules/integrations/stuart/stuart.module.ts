import { forwardRef, Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { OrdersModule } from "../../orders/orders.module";
import { CredentialEncryptionService } from "../credential-encryption.service";
import { StuartClientService } from "./stuart-client.service";
import { StuartConfigService } from "./stuart-config.service";
import { StuartDispatchService } from "./stuart-dispatch.service";
import { StuartWebhookService } from "./stuart-webhook.service";
import { StuartController } from "./stuart.controller";
import { StuartWebhookController } from "./stuart-webhook.controller";

// Phase BH — Stuart last-mile courier dispatch. WalletService is @Global; the
// courier webhook bumps order status via OrdersService (forwardRef guards the
// Orders web of module deps).
@Module({
  imports: [ConfigModule, forwardRef(() => OrdersModule)],
  controllers: [StuartController, StuartWebhookController],
  providers: [
    StuartClientService,
    StuartConfigService,
    StuartDispatchService,
    StuartWebhookService,
    CredentialEncryptionService,
  ],
  exports: [StuartConfigService, StuartDispatchService],
})
export class StuartModule {}
