import { Module } from '@nestjs/common';
import { CustomersController, PromoCodesController } from './customers.controller';
import { CustomersService } from './customers.service';
import { CallerIdSetupService } from './caller-id-setup.service';
import { SocketModule } from '../../infrastructure/socket/socket.module';
import { LocationAccessService } from '../../common/access/location-access.service';

@Module({
  // SocketModule: the caller-ID ring endpoint broadcasts "callerid:ring" to
  // every POS tablet in the location's room.
  imports: [SocketModule],
  controllers: [CustomersController, PromoCodesController],
  // LocationAccessService: the caller-ID ring endpoint takes a locationId
  // from the client, so it has to check the caller may act on that shop —
  // same rules as the orders board, imported rather than re-implemented.
  providers: [CustomersService, CallerIdSetupService, LocationAccessService],
  // CallerIdSetupService is exported so the voice module can feed the same
  // "is it arriving?" light when a caller reaches us by simultaneous ring.
  exports: [CustomersService, CallerIdSetupService],
})
export class CustomersModule {}
