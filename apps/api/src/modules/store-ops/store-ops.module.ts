import { Module } from '@nestjs/common';
import { StoreOpsController } from './store-ops.controller';
import { StoreOpsService } from './store-ops.service';
import { SocketModule } from '../../infrastructure/socket/socket.module';

@Module({
  imports: [SocketModule],
  controllers: [StoreOpsController],
  providers: [StoreOpsService],
  exports: [StoreOpsService],
})
export class StoreOpsModule {}
