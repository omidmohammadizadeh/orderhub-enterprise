import { Module } from "@nestjs/common";
import { CustomerPushController } from "./customer-push.controller";
import { CustomerPushService } from "./customer-push.service";

// Customer-facing web push. PrismaService is global, so this wires only its
// own providers. Exported because OrdersModule calls notifyOrderStatus when
// an order moves — the import goes that way round (orders → push) so the push
// side never needs to know what an order is beyond its id and status.
@Module({
  controllers: [CustomerPushController],
  providers: [CustomerPushService],
  exports: [CustomerPushService],
})
export class CustomerPushModule {}
