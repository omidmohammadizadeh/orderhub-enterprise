import { Module } from "@nestjs/common";
import { WhatsAppController } from "./whatsapp.controller";
import { WhatsAppService } from "./whatsapp.service";
import { WhatsAppAiService } from "./whatsapp-ai.service";
import { WhatsAppMenuService } from "./whatsapp-menu.service";
import { WhatsAppSendService } from "./whatsapp-send.service";
import { OrdersModule } from "../orders/orders.module";
import { PaymentsModule } from "../payments/payments.module";

// Phase AY — WhatsApp ordering channel (Meta Cloud API).
//   P1: webhook verify + inbound parse.
//   P2: AI conversation engine — live menu, Claude NLU + cart tools,
//       interactive replies (this module's services).
//   P3+: order creation, payments, status replies, dashboard connect.
@Module({
  imports: [OrdersModule, PaymentsModule],
  controllers: [WhatsAppController],
  providers: [
    WhatsAppService,
    WhatsAppAiService,
    WhatsAppMenuService,
    WhatsAppSendService,
  ],
  exports: [WhatsAppService],
})
export class WhatsAppModule {}
