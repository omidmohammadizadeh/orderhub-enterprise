import { Module } from "@nestjs/common";
import { AddressLookupController } from "./address-lookup.controller";
import { AddressLookupService } from "./address-lookup.service";

@Module({
  controllers: [AddressLookupController],
  providers: [AddressLookupService],
  exports: [AddressLookupService],
})
export class AddressLookupModule {}
