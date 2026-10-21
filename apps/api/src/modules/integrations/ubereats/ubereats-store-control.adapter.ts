import { Injectable } from "@nestjs/common";
import {
  normalizeStoreState,
  type StoreControlDriver,
  type StorePauseOptions,
  type StoreStatus,
} from "../shared/store-control";
import { UberEatsConnectionService } from "./ubereats-connection.service";

// Uber Eats in the shared store-control vocabulary.
//
// Delegation only — the live-verified rules (OFFLINE needs is_offline_until,
// the activation retry, the activity log that records Uber's acknowledgment)
// stay in UberEatsConnectionService, which is still called directly by the
// controller. This adapter exists so callers that do not care which channel
// they are talking to don't have to learn Uber's vocabulary.
@Injectable()
export class UberEatsStoreControlAdapter implements StoreControlDriver {
  readonly platform = "UBER_EATS" as const;
  readonly canReadStatus = true;

  constructor(private readonly connections: UberEatsConnectionService) {}

  async setStoreOpen(
    tenantId: string,
    connectionId: string,
    open: boolean,
    options?: StorePauseOptions,
  ) {
    // The +24h default for an open-ended pause is the service's own rule, so
    // `until` is passed through as-is rather than defaulted here twice.
    const res = await this.connections.setStoreOnline(
      tenantId,
      connectionId,
      open,
      options?.reason,
      options?.until ?? null,
    );
    return { state: normalizeStoreState(res.status), raw: res.status };
  }

  async storeStatus(tenantId: string, connectionId: string): Promise<StoreStatus> {
    const s = await this.connections.storeStatus(tenantId, connectionId);
    return {
      state: normalizeStoreState(s.status),
      raw: s.status,
      until: s.offlineUntil ?? null,
      reason: s.offlineReason ?? null,
    };
  }
}
