import { Module } from "@nestjs/common";
import { OrdersModule } from "../orders/orders.module";
import { PaymentsModule } from "../payments/payments.module";
import { GroupOrdersController } from "./group-orders.controller";
import { OrderingModule } from "../ordering/ordering.module";
import { GroupOrdersService } from "./group-orders.service";

// Group ordering — shared baskets. PrismaService is global, so this module
// only wires its own providers.
//
// Imports OrdersModule for OrdersService.create — placing a basket goes
// through the ordinary order path rather than a second one, so a group order
// prints, routes and settles exactly like any other online order.
//
// PaymentsModule is the same reason: a CARD group order gets an ordinary
// hosted Stripe Checkout session rather than a second payment path.
@Module({
  // OrderingModule: a group basket is placed through the storefront checkout,
  // so it is priced, zoned and paid for exactly like any online order.
  imports: [OrdersModule, PaymentsModule, OrderingModule],
  controllers: [GroupOrdersController],
  providers: [GroupOrdersService],
  exports: [GroupOrdersService],
})
export class GroupOrdersModule {}
