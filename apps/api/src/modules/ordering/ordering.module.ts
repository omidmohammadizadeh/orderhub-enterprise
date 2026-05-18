import { Module } from "@nestjs/common";
import { OrderingController } from "./ordering.controller";
import { OrderingService } from "./ordering.service";
import { OrdersModule } from "../orders/orders.module";

@Module({
  imports: [OrdersModule],
  controllers: [OrderingController],
  providers: [OrderingService],
})
export class OrderingModule {}
