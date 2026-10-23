import { Module } from "@nestjs/common";
import { ModuleRef } from "@nestjs/core";
import { ConfigModule } from "@nestjs/config";
import { PayoutsModule } from "../payouts/payouts.module";
import { PaymentsController } from "./payments.controller";
import { DOJO_PAYMENT_LINKS, MOLLIE_PAYMENT_LINKS, PaymentsService } from "./payments.service";
import { TerminalController } from "./terminal.controller";
import { TerminalService } from "./terminal.service";
import { ReceiptEmailService } from "./receipt-email.service";
import { TapService } from "./tap.service";
import { CredentialEncryptionService } from "../integrations/credential-encryption.service";
import { DojoController } from "./dojo/dojo.controller";
import { DojoEposController } from "./dojo/dojo-epos.controller";
import { DojoService } from "./dojo/dojo.service";
import { DojoEposService } from "./dojo/dojo-epos.service";
import { MollieController } from "./mollie/mollie.controller";
import { MollieService } from "./mollie/mollie.service";

@Module({
  imports: [ConfigModule, PayoutsModule],
  controllers: [PaymentsController, TerminalController, DojoController, DojoEposController, MollieController],
  providers: [
    PaymentsService,
    TerminalService,
    ReceiptEmailService,
    TapService,
    DojoService,
    DojoEposService,
    MollieService,
    // Lets PaymentsService ask "is this shop's pay-by-link on Dojo?" without
    // importing DojoService, which imports PaymentsService (see the token).
    //
    // Resolved through ModuleRef at CALL time, not injected: DojoService needs
    // PaymentsService, so `useExisting: DojoService` would be a provider cycle
    // and nothing would start. By the time a till asks for a link, both exist.
    {
      provide: DOJO_PAYMENT_LINKS,
      useFactory: (ref: ModuleRef) => ({
        paymentLinkForOrder: (tenantId: string, orderId: string) =>
          ref.get(DojoService, { strict: false }).paymentLinkForOrder(tenantId, orderId),
      }),
      inject: [ModuleRef],
    },
    // Same arrangement for Mollie pay-by-link: MollieService needs
    // PaymentsService, so it is looked up at call time, not injected.
    {
      provide: MOLLIE_PAYMENT_LINKS,
      useFactory: (ref: ModuleRef) => ({
        paymentLinkForOrder: (tenantId: string, orderId: string) =>
          ref.get(MollieService, { strict: false }).paymentLinkForOrder(tenantId, orderId),
      }),
      inject: [ModuleRef],
    },
    // Provided here rather than importing IntegrationsModule, same as the
    // JET/Stuart modules — it's stateless apart from the env key.
    CredentialEncryptionService,
  ],
  exports: [PaymentsService, TerminalService, ReceiptEmailService, TapService, DojoService, MollieService],
})
export class PaymentsModule {}
