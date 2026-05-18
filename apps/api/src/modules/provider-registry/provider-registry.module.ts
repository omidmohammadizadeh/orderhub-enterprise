import { Module } from "@nestjs/common";
import { ProviderRegistryController } from "./provider-registry.controller";
import { ProviderRegistryService } from "./provider-registry.service";

@Module({
  controllers: [ProviderRegistryController],
  providers: [ProviderRegistryService],
  exports: [ProviderRegistryService],
})
export class ProviderRegistryModule {}
