import { Module } from "@nestjs/common";
import { BrandConnectionsController } from "./brand-connections.controller";
import { BrandConnectionsService } from "./brand-connections.service";

@Module({
  controllers: [BrandConnectionsController],
  providers: [BrandConnectionsService],
  exports: [BrandConnectionsService],
})
export class BrandConnectionsModule {}
