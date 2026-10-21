import { Module } from "@nestjs/common";
import { CustomerPushController } from "./customer-push.controller";
import { CustomerPushService } from "./customer-push.service";
import { PushAdminController } from "./push-admin.controller";
import { PushCampaignsService } from "./push-campaigns.service";

// Customer-facing web push. PrismaService is global, so this wires only its
// own providers. Exported because OrdersModule calls notifyOrderStatus when
// an order moves — the import goes that way round (orders → push) so the push
// side never needs to know what an order is beyond its id and status.
@Module({
  controllers: [CustomerPushController, PushAdminController],
  providers: [CustomerPushService, PushCampaignsService],
  exports: [CustomerPushService],
})
export class CustomerPushModule {}
