import { Module, forwardRef } from '@nestjs/common';
import { BrandsController } from './brands.controller';
import { BrandsService } from './brands.service';
import { CloudflareService } from './cloudflare.service';
import { RenderDomainsService } from './render-domains.service';
import { HubRiseModule } from '../integrations/hubrise/hubrise.module';
import { UberEatsModule } from "../integrations/ubereats/ubereats.module";
import { DeliverooModule } from '../integrations/deliveroo/deliveroo.module';

@Module({
  // Phase AW-16 — HubRiseModule provides HubRiseLocationPauseService
  // (also covers the publishHours method). forwardRef in case the
  // HubRise side ever wants brands back.
  // Phase BA-2 — DeliverooModule provides DeliverooConnectionService for the
  // direct Deliveroo hours push (one-way import, no cycle).
  imports: [forwardRef(() => HubRiseModule), DeliverooModule, UberEatsModule],
  controllers: [BrandsController],
  providers: [BrandsService, CloudflareService, RenderDomainsService],
  exports: [BrandsService],
})
export class BrandsModule {}
