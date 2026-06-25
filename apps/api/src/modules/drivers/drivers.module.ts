import { Module } from '@nestjs/common';
import { DriversController } from './drivers.controller';
import { DriversService } from './drivers.service';
import { SocketModule } from '../../infrastructure/socket/socket.module';
import { DriverAppModule } from '../driver-app/driver-app.module';

@Module({
  imports: [SocketModule, DriverAppModule],
  controllers: [DriversController],
  providers: [DriversService],
  exports: [DriversService],
})
export class DriversModule {}
