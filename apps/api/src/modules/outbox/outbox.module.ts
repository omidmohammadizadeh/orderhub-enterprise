import { Module } from "@nestjs/common";
import { BullModule } from "@nestjs/bull";
import { QUEUES } from "@orderhub/shared";
import { OutboxService } from "./outbox.service";
import { OutboxDispatcherCron } from "./outbox-dispatcher.cron";

@Module({
  imports: [
    BullModule.registerQueue({ name: QUEUES.ORDER_PROCESSING }),
  ],
  providers: [OutboxService, OutboxDispatcherCron],
  exports: [OutboxService, OutboxDispatcherCron],
})
export class OutboxModule {}
