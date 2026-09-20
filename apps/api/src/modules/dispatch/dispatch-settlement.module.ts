import { Module } from "@nestjs/common";
import { DispatchSettlementService } from "./dispatch-settlement.service";

// Its own module rather than a provider on DispatchModule, because OrdersModule
// is what needs it and DispatchModule reaches OrdersModule the long way round
// (DriverAppModule → HubRiseModule → WebhooksModule → OrdersModule). This one
// imports nothing at all — PrismaService is @Global — so it can be pulled into
// any module without risking a cycle.
@Module({
  providers: [DispatchSettlementService],
  exports: [DispatchSettlementService],
})
export class DispatchSettlementModule {}
