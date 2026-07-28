import { Module } from "@nestjs/common";
import { TablesController } from "./tables.controller";
import { TablesService } from "./tables.service";
import { TableQrController } from "./table-qr.controller";
import { TableQrService } from "./table-qr.service";
import { OrdersModule } from "../orders/orders.module";

// QR-at-table reuses OrdersService to open or append a tab, so a guest
// round takes the exact same path as a waiter round. OrdersModule
// doesn't import this one back (it frees tables via Prisma directly),
// so a plain import is enough — no forwardRef needed.
@Module({
  imports: [OrdersModule],
  controllers: [TablesController, TableQrController],
  providers: [TablesService, TableQrService],
  exports: [TablesService],
})
export class TablesModule {}
