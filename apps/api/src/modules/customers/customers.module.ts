import { Module } from '@nestjs/common';
import { CustomersController, PromoCodesController } from './customers.controller';
import { CustomersService } from './customers.service';
import { SocketModule } from '../../infrastructure/socket/socket.module';

@Module({
  // SocketModule: the caller-ID ring endpoint broadcasts "callerid:ring" to
  // every POS tablet in the location's room.
  imports: [SocketModule],
  controllers: [CustomersController, PromoCodesController],
  providers: [CustomersService],
  exports: [CustomersService],
})
export class CustomersModule {}
