import { Global, Module } from "@nestjs/common";
import { JwtModule } from "@nestjs/jwt";
import { ConfigModule, ConfigService } from "@nestjs/config";
import { OrdersGateway } from "./gateways/orders.gateway";
import { KdsGateway } from "./gateways/kds.gateway";
import { SocketService } from "./socket.service";
import { RedisSubscriberService } from "./redis-subscriber.service";
import { DatabaseModule } from "../database/database.module";

// @Global so any module can inject SocketService to emit events
// without importing SocketModule directly.
@Global()
@Module({
  imports: [
    DatabaseModule,
    JwtModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        secret: config.get<string>("JWT_SECRET") ?? "dev-secret",
        signOptions: { expiresIn: "15m" },
      }),
    }),
  ],
  providers: [SocketService, OrdersGateway, KdsGateway, RedisSubscriberService],
  exports: [SocketService],
})
export class SocketModule {}
