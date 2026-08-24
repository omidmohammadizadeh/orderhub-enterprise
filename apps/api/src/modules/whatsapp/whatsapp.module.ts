import { Module } from "@nestjs/common";
import { LoyaltyModule } from "../loyalty/loyalty.module";
import { WhatsAppController } from "./whatsapp.controller";
import { WhatsAppConnectionController } from "./whatsapp-connection.controller";
import { WhatsAppConnectionService } from "./whatsapp-connection.service";
import { WhatsAppService } from "./whatsapp.service";
import { WhatsAppAiService } from "./whatsapp-ai.service";
import { WhatsAppMenuService } from "./whatsapp-menu.service";
import { WhatsAppSendService } from "./whatsapp-send.service";
import { WhatsAppNotifyService } from "./whatsapp-notify.service";
import { WhatsAppReconcileCron } from "./whatsapp-reconcile.cron";
import { OrdersModule } from "../orders/orders.module";
import { PaymentsModule } from "../payments/payments.module";
import { PauseModule } from "../pauses/pause.module";
import { MarketingModule } from "../marketing/marketing.module";
import { MenuAssignmentsModule } from "../menus/menu-assignments.module";
import { VariantPriceResolverModule } from "../menus/variant-price-resolver.module";

// Phase AY — WhatsApp ordering channel (Meta Cloud API).
//   P1: webhook verify + inbound parse.
//   P2: AI conversation engine — live menu, Claude NLU + cart tools,
//       interactive replies (this module's services).
//   P3+: order creation, payments, status replies, dashboard connect.
@Module({
  imports: [
    // Referral verification is answered before the ordering AI sees the
    // message. One-way: Loyalty never reaches back into WhatsApp.
    LoyaltyModule,
    OrdersModule,
    PaymentsModule,
    PauseModule,
    MarketingModule,
    MenuAssignmentsModule,
    VariantPriceResolverModule,
  ],
  controllers: [WhatsAppController, WhatsAppConnectionController],
  providers: [
    WhatsAppService,
    WhatsAppConnectionService,
    WhatsAppAiService,
    WhatsAppMenuService,
    WhatsAppSendService,
    WhatsAppNotifyService,
    WhatsAppReconcileCron,
  ],
  // WhatsAppMenuService is exported for the AI phone line, which serves the
  // same live menu (serving assignments, variant pricing, 86'd items) rather
  // than growing a second copy that drifts out of step.
  exports: [WhatsAppService, WhatsAppMenuService],
})
export class WhatsAppModule {}
