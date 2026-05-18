import { Global, Module } from "@nestjs/common";
import { MetricsService, ErrorTrackerService } from "./metrics.service";

// ── @Global so every module gets MetricsService/ErrorTrackerService without
// importing ObservabilityModule individually. ─────────────────────────────
@Global()
@Module({
  providers: [MetricsService, ErrorTrackerService],
  exports: [MetricsService, ErrorTrackerService],
})
export class ObservabilityModule {}
