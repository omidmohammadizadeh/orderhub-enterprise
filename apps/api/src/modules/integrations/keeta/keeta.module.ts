import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { VariantPriceResolverModule } from "../../menus/variant-price-resolver.module";
import { OrdersModule } from "../../orders/orders.module";
import { CredentialEncryptionService } from "../credential-encryption.service";
import { KeetaAuthService } from "./keeta-auth.service";
import { KeetaClientService } from "./keeta-client.service";
import { KeetaConnectionService } from "./keeta-connection.service";
import { KeetaItemAvailabilityService } from "./keeta-item-availability.service";
import { KeetaMenuPublishService } from "./keeta-menu-publish.service";
import { KeetaOrderService } from "./keeta-order.service";
import { KeetaOrderSyncService } from "./keeta-order-sync.service";
import { KeetaStoreService } from "./keeta-store.service";
import { KeetaWebhookLogService } from "./keeta-webhook-log.service";
import { KeetaController } from "./keeta.controller";
import { KeetaWebhookController } from "./keeta-webhook.controller";

// Phase KT — direct Keeta (Meituan) integration, Standard Keeta API.
//
// KT-0 transport + signing, KT-1 merchant OAuth + store mapping, KT-2 order
// intake + inbound status + refunds, KT-3 status push, KT-4 menu sync + 86,
// KT-5 store open/close + hours. See docs/keeta-integration.md.
//
// OrdersModule is a one-way import (as for Glovo/Careem); ActivityLogService
// comes from the @Global() LogsModule and is injected @Optional().
@Module({
  imports: [ConfigModule, OrdersModule, VariantPriceResolverModule],
  controllers: [KeetaController, KeetaWebhookController],
  providers: [
    CredentialEncryptionService,
    KeetaClientService,
    KeetaAuthService,
    KeetaConnectionService,
    KeetaOrderService,
    KeetaOrderSyncService,
    KeetaMenuPublishService,
    KeetaItemAvailabilityService,
    KeetaStoreService,
    KeetaWebhookLogService,
  ],
  exports: [KeetaClientService, KeetaMenuPublishService, KeetaItemAvailabilityService, KeetaStoreService],
})
export class KeetaModule {}
