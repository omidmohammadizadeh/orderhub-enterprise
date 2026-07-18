import { forwardRef, Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { OrdersModule } from "../../orders/orders.module";
import { CredentialEncryptionService } from "../credential-encryption.service";
import { UberDirectClientService } from "./uber-direct-client.service";
import { UberDirectConfigService } from "./uber-direct-config.service";
import { UberDirectDispatchService } from "./uber-direct-dispatch.service";
import { UberDirectWebhookService } from "./uber-direct-webhook.service";
import { UberDirectController } from "./uber-direct.controller";
import { UberDirectWebhookController } from "./uber-direct-webhook.controller";

// Phase BI — Uber Direct last-mile courier dispatch. Mirrors StuartModule;
// WalletService is @Global; the webhook bumps order status via OrdersService.
@Module({
  imports: [ConfigModule, forwardRef(() => OrdersModule)],
  controllers: [UberDirectController, UberDirectWebhookController],
  providers: [
    UberDirectClientService,
    UberDirectConfigService,
    UberDirectDispatchService,
    UberDirectWebhookService,
    CredentialEncryptionService,
  ],
  exports: [UberDirectConfigService, UberDirectDispatchService],
})
export class UberDirectModule {}
