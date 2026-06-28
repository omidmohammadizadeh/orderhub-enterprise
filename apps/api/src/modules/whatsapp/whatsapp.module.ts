import { Module } from "@nestjs/common";
import { WhatsAppController } from "./whatsapp.controller";
import { WhatsAppService } from "./whatsapp.service";

// Phase AY — WhatsApp ordering channel (Meta Cloud API). P1 wires the webhook;
// later phases add the conversation engine, order creation, payments + replies.
@Module({
  controllers: [WhatsAppController],
  providers: [WhatsAppService],
  exports: [WhatsAppService],
})
export class WhatsAppModule {}
