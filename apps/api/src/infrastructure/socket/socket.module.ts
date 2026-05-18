import { Global, Module } from "@nestjs/common";
import { OrdersGateway } from "./gateways/orders.gateway";
import { KdsGateway } from "./gateways/kds.gateway";
import { SocketService } from "./socket.service";
import { RedisSubscriberService } from "./redis-subscriber.service";

// @Global so any module can inject SocketService to emit events
// without importing SocketModule directly.
@Global()
@Module({
  providers: [SocketService, OrdersGateway, KdsGateway, RedisSubscriberService],
  exports: [SocketService],
})
export class SocketModule {}
