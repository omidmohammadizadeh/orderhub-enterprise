import { Module } from "@nestjs/common";
import { KioskController } from "./kiosk.controller";
import { KioskService } from "./kiosk.service";
import { OrdersModule } from "../orders/orders.module";
import { MenusModule } from "../menus/menus.module";

// Kiosk orders go through OrdersService.create, so a self-service order
// takes the identical path to a till order — same auto-accept, same KDS
// dispatch, same print pipeline. Nothing kiosk-specific touches money.
@Module({
  imports: [OrdersModule, MenusModule],
  controllers: [KioskController],
  providers: [KioskService],
  exports: [KioskService],
})
export class KioskModule {}
