import { Module } from "@nestjs/common";
import { BullModule } from "@nestjs/bull";
import { QUEUES } from "@orderhub/shared";
import { SandboxController } from "./sandbox.controller";
import { SandboxService } from "./sandbox.service";

@Module({
  imports: [BullModule.registerQueue({ name: QUEUES.ORDER_PROCESSING })],
  controllers: [SandboxController],
  providers: [SandboxService],
  exports: [SandboxService],
})
export class SandboxModule {}
