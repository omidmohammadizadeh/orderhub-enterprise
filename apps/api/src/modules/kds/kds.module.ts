import { Module } from '@nestjs/common';
import { KdsController } from './kds.controller';
import { KdsService } from './kds.service';
import { KdsDispatchService } from './kds-dispatch.service';
import { KdsFireCron } from './kds-fire.cron';
import { SocketModule } from '../../infrastructure/socket/socket.module';
import { OrdersModule } from '../orders/orders.module';

// Phase KD — OrdersModule is a one-way import (KDS listens to
// order.status_changed and calls updateStatus; nothing in Orders reaches
// back into KDS), so no forwardRef is needed.
@Module({
  imports: [SocketModule, OrdersModule],
  controllers: [KdsController],
  providers: [KdsService, KdsDispatchService, KdsFireCron],
  exports: [KdsService],
})
export class KdsModule {}
