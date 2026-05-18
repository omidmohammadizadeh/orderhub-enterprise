import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";

export type FeatureFlag =
  | "analytics"
  | "dispatch"
  | "kds"
  | "maintenanceMode";

// ── Feature flags service ──────────────────────────────────────────────────
// Currently backed by environment variables (ENABLE_* config). The interface
// is designed so it can be swapped for a remote provider (LaunchDarkly,
// GrowthBook, Unleash) by changing only this service — callers are unaffected.
@Injectable()
export class FeatureFlagsService {
  constructor(private readonly config: ConfigService) {}

  isEnabled(flag: FeatureFlag, _context?: { tenantId?: string; userId?: string }): boolean {
    switch (flag) {
      case "analytics":
        return this.config.get<boolean>("app.features.analytics") ?? true;
      case "dispatch":
        return this.config.get<boolean>("app.features.dispatch") ?? true;
      case "kds":
        return this.config.get<boolean>("app.features.kds") ?? true;
      case "maintenanceMode":
        return this.config.get<boolean>("app.features.maintenanceMode") ?? false;
      default:
        return false;
    }
  }

  isDisabled(flag: FeatureFlag, context?: { tenantId?: string; userId?: string }): boolean {
    return !this.isEnabled(flag, context);
  }

  all(): Record<FeatureFlag, boolean> {
    return {
      analytics: this.isEnabled("analytics"),
      dispatch: this.isEnabled("dispatch"),
      kds: this.isEnabled("kds"),
      maintenanceMode: this.isEnabled("maintenanceMode"),
    };
  }
}
