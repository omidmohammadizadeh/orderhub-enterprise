import { Module } from "@nestjs/common";
import { OrderingController } from "./ordering.controller";
import { OrderingService } from "./ordering.service";
import { OrdersModule } from "../orders/orders.module";
import { PromoCodesModule } from "../promo-codes/promo-codes.module";

@Module({
  imports: [OrdersModule, PromoCodesModule],
  controllers: [OrderingController],
  providers: [OrderingService],
})
export class OrderingModule {}
