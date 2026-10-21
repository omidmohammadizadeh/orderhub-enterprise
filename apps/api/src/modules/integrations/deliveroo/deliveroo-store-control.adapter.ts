import { Injectable } from "@nestjs/common";
import {
  normalizeStoreState,
  type StoreControlDriver,
  type StorePauseOptions,
  type StoreStatus,
} from "../shared/store-control";
import { DeliverooConnectionService } from "./deliveroo-connection.service";

// Deliveroo in the shared store-control vocabulary.
//
// Deliveroo's status call carries no end time: a closed site stays closed
// until something opens it. `until` is therefore accepted and ignored here,
// which is better than pretending to schedule a reopen that nobody will send.
@Injectable()
export class DeliverooStoreControlAdapter implements StoreControlDriver {
  readonly platform = "DELIVEROO" as const;
  readonly canReadStatus = true;

  constructor(private readonly connections: DeliverooConnectionService) {}

  async setStoreOpen(
    tenantId: string,
    connectionId: string,
    open: boolean,
    _options?: StorePauseOptions,
  ) {
    const res = await this.connections.setStoreOpen(tenantId, connectionId, open);
    return { state: normalizeStoreState(res.status), raw: res.status };
  }

  async storeStatus(tenantId: string, connectionId: string): Promise<StoreStatus> {
    const s = await this.connections.storeStatus(tenantId, connectionId);
    return {
      state: normalizeStoreState(s.status),
      raw: s.status,
      until: null,
      reason: null,
    };
  }
}
