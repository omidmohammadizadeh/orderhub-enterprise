import { Module } from "@nestjs/common";
import { TablesController } from "./tables.controller";
import { TablesService } from "./tables.service";
import { TableQrController } from "./table-qr.controller";
import { TableQrService } from "./table-qr.service";
import { OrdersModule } from "../orders/orders.module";
import { PaymentsModule } from "../payments/payments.module";

// QR-at-table reuses OrdersService to open or append a tab, so a guest
// round takes the exact same path as a waiter round. OrdersModule
// doesn't import this one back (it frees tables via Prisma directly),
// so a plain import is enough — no forwardRef needed.
//
// PaymentsModule is for the pay-before-kitchen flow: the same
// createStorefrontPaymentIntent the storefront mints its wallet payments
// with, so a table charge is a direct charge on the shop's own connected
// account like every other card we take. It doesn't import this module
// back either, so again no forwardRef.
@Module({
  imports: [OrdersModule, PaymentsModule],
  controllers: [TablesController, TableQrController],
  providers: [TablesService, TableQrService],
  exports: [TablesService],
})
export class TablesModule {}
