// Phase BF — tiny standalone module (mirrors MenuAssignmentsModule) so
// Ordering, WhatsApp, UberEats and Deliveroo can all import the variant
// price resolver without creating module cycles (PrismaService is @Global
// via DatabaseModule, so no imports needed here).

import { Module } from "@nestjs/common";
import { VariantPriceResolverService } from "./variant-price-resolver.service";

@Module({
  providers: [VariantPriceResolverService],
  exports: [VariantPriceResolverService],
})
export class VariantPriceResolverModule {}
