import { Module } from "@nestjs/common";
import { GroupOrdersController } from "./group-orders.controller";
import { GroupOrdersService } from "./group-orders.service";

// Group ordering — shared baskets. PrismaService is global, so this module
// only wires its own providers.
//
// NOT BUILT YET: placing the basket as a real Order. That step composes a
// CreateOrderDto from the lines and calls OrdersService.create, and is where
// fees, promos and payment land — deliberately left for a session with the
// budget to read that DTO properly and test it.
@Module({
  controllers: [GroupOrdersController],
  providers: [GroupOrdersService],
  exports: [GroupOrdersService],
})
export class GroupOrdersModule {}
