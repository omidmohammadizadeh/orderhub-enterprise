import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { PayoutsModule } from "../payouts/payouts.module";
import { PaymentsController } from "./payments.controller";
import { PaymentsService } from "./payments.service";
import { TerminalController } from "./terminal.controller";
import { TerminalService } from "./terminal.service";
import { ReceiptEmailService } from "./receipt-email.service";
import { TapService } from "./tap.service";
import { CredentialEncryptionService } from "../integrations/credential-encryption.service";
import { DojoController } from "./dojo/dojo.controller";
import { DojoEposController } from "./dojo/dojo-epos.controller";
import { DojoService } from "./dojo/dojo.service";
import { DojoEposService } from "./dojo/dojo-epos.service";

@Module({
  imports: [ConfigModule, PayoutsModule],
  controllers: [PaymentsController, TerminalController, DojoController, DojoEposController],
  providers: [
    PaymentsService,
    TerminalService,
    ReceiptEmailService,
    TapService,
    DojoService,
    DojoEposService,
    // Provided here rather than importing IntegrationsModule, same as the
    // JET/Stuart modules — it's stateless apart from the env key.
    CredentialEncryptionService,
  ],
  exports: [PaymentsService, TerminalService, ReceiptEmailService, TapService, DojoService],
})
export class PaymentsModule {}
