import { Module } from '@nestjs/common';
import { CustomersController, PromoCodesController } from './customers.controller';
import { CustomersService } from './customers.service';
import { CallerIdSetupService } from './caller-id-setup.service';
import { SocketModule } from '../../infrastructure/socket/socket.module';

@Module({
  // SocketModule: the caller-ID ring endpoint broadcasts "callerid:ring" to
  // every POS tablet in the location's room.
  imports: [SocketModule],
  controllers: [CustomersController, PromoCodesController],
  providers: [CustomersService, CallerIdSetupService],
  // CallerIdSetupService is exported so the voice module can feed the same
  // "is it arriving?" light when a caller reaches us by simultaneous ring.
  exports: [CustomersService, CallerIdSetupService],
})
export class CustomersModule {}
