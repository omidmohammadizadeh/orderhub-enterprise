import { Module } from '@nestjs/common';
import { CustomersController, PromoCodesController } from './customers.controller';
import { CustomersService } from './customers.service';

@Module({
  controllers: [CustomersController, PromoCodesController],
  providers: [CustomersService],
  exports: [CustomersService],
})
export class CustomersModule {}
