import { Module } from "@nestjs/common";
import { OrdersModule } from "../orders/orders.module";
import { PaymentsModule } from "../payments/payments.module";
import { WhatsAppModule } from "../whatsapp/whatsapp.module";
import { VoiceController } from "./voice.controller";
import { VoiceService } from "./voice.service";
import { VoiceAiService } from "./voice-ai.service";
import { VoiceContextService } from "./voice-context.service";

// AI phone line.
//
// WhatsAppModule is imported for WhatsAppMenuService — the phone reads the SAME
// live menu the chat bot does (serving assignments, variant pricing, 86'd
// items), because a second menu pipeline would drift and a phone line quoting a
// stale price is worse than one that doesn't answer.
//
// OrdersModule so a phone order lands on the board and prints like any other.
// PaymentsModule for the card path: nobody reads a card number aloud to a
// machine, so card orders get a Stripe link by text.
// SmsService and WalletService are both @Global — the latter holds the per-call
// billing and the gate that decides whether we pick up at all.
@Module({
  imports: [OrdersModule, PaymentsModule, WhatsAppModule],
  controllers: [VoiceController],
  providers: [VoiceService, VoiceAiService, VoiceContextService],
  exports: [VoiceService],
})
export class VoiceModule {}
