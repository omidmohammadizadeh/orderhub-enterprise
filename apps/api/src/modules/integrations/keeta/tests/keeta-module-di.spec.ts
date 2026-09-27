import { Test } from "@nestjs/testing";
import { ConfigModule } from "@nestjs/config";
import { EventEmitterModule } from "@nestjs/event-emitter";
import { Global, Module } from "@nestjs/common";
import { PrismaService } from "../../../../infrastructure/database/prisma.service";
import { KeetaModule } from "../keeta.module";
import { KeetaController } from "../keeta.controller";
import { KeetaWebhookController } from "../keeta-webhook.controller";
import { KeetaOrderSyncService } from "../keeta-order-sync.service";

// Wiring check: the module resolves every provider and controller. A missing
// export or import here is an API that never boots on deploy.
@Global()
@Module({ providers: [{ provide: PrismaService, useValue: {} }], exports: [PrismaService] })
class FakePrismaModule {}

jest.mock("../../../orders/orders.module", () => {
  const { Module } = jest.requireActual("@nestjs/common");
  const { OrdersService } = jest.requireActual("../../../orders/orders.service");
  @Module({ providers: [{ provide: OrdersService, useValue: {} }], exports: [OrdersService] })
  class OrdersModule {}
  return { OrdersModule };
});

describe("KeetaModule wiring", () => {
  it("resolves every provider and controller", async () => {
    const mod = await Test.createTestingModule({
      imports: [ConfigModule.forRoot({ isGlobal: true }), EventEmitterModule.forRoot(), FakePrismaModule, KeetaModule],
    }).compile();
    expect(mod.get(KeetaController)).toBeDefined();
    expect(mod.get(KeetaWebhookController)).toBeDefined();
    expect(mod.get(KeetaOrderSyncService)).toBeDefined();
  });
});
