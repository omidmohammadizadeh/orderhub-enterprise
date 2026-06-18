import { Module } from "@nestjs/common";
import { StoreStatusController } from "./store-status.controller";
import { StoreStatusService } from "./store-status.service";

// Phase AW-21 — Read-only aggregator over the operational signals
// emitted by AW-14 (item snooze) and AW-15 (channel pause + busy).
// No mutations live here; the page links into the existing
// inventory / orders pages when an operator wants to act.

@Module({
  controllers: [StoreStatusController],
  providers: [StoreStatusService],
})
export class StoreStatusModule {}
