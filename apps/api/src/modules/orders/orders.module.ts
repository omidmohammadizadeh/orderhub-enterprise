import { Module } from "@nestjs/common";
import { OrdersService } from "./orders.service";
import { OrdersController } from "./orders.controller";
import { SocketModule } from "../../infrastructure/socket/socket.module";
import { AuthModule } from "../auth/auth.module";
import { OutboxModule } from "../outbox/outbox.module";
import { PrintersModule } from "../printers/printers.module";
import { PromoCodesModule } from "../promo-codes/promo-codes.module";

@Module({
  imports: [
    SocketModule,
    AuthModule,
    OutboxModule,
    PrintersModule, // Phase AM — wire PrintQueueService for POS auto-print
    PromoCodesModule, // Phase AM — incrementUsage on confirmed order
  ],
  controllers: [OrdersController],
  providers: [OrdersService],
  exports: [OrdersService],
})
export class OrdersModule {}
