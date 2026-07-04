import { Module } from "@nestjs/common";
import { MarketingController } from "./marketing.controller";
import { MarketingService } from "./marketing.service";
import { UberEatsModule } from "../integrations/ubereats/ubereats.module";

// UberEatsModule provides UberEatsPromotionsService — campaigns with the
// UBER_EATS channel are mirrored to Uber's Promotions API on create/update
// and revoked on pause/delete (UE-6). One-way import, no cycle.
@Module({
  imports: [UberEatsModule],
  controllers: [MarketingController],
  providers: [MarketingService],
  exports: [MarketingService],
})
export class MarketingModule {}
