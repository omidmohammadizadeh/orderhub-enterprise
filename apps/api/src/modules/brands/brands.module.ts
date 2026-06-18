import { Module, forwardRef } from '@nestjs/common';
import { BrandsController } from './brands.controller';
import { BrandsService } from './brands.service';
import { HubRiseModule } from '../integrations/hubrise/hubrise.module';

@Module({
  // Phase AW-16 — HubRiseModule provides HubRiseLocationPauseService
  // (also covers the publishHours method). forwardRef in case the
  // HubRise side ever wants brands back.
  imports: [forwardRef(() => HubRiseModule)],
  controllers: [BrandsController],
  providers: [BrandsService],
  exports: [BrandsService],
})
export class BrandsModule {}
