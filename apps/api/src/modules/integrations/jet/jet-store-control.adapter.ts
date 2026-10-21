import { Injectable } from "@nestjs/common";
import {
  StoreStatusUnavailableError,
  type StoreControlDriver,
  type StorePauseOptions,
  type StoreStatus,
} from "../shared/store-control";
import { JetStoreStatusService } from "./jet-store-status.service";

// Just Eat in the shared store-control vocabulary.
//
// Two things make JET the odd one out:
//   • There is no endpoint to read a restaurant's trading state back. JET's
//     own "store-status" route is INBOUND — them telling us a restaurant went
//     temporarily offline — so this adapter refuses the read rather than
//     reporting a state nobody confirmed.
//   • A pause with no end time is indefinite, which is a real operational
//     hazard; the service already logs that plainly, and `until` maps onto
//     its `onlineAt`.
@Injectable()
export class JetStoreControlAdapter implements StoreControlDriver {
  readonly platform = "JUST_EAT" as const;
  readonly canReadStatus = false;

  constructor(private readonly status: JetStoreStatusService) {}

  async setStoreOpen(
    tenantId: string,
    connectionId: string,
    open: boolean,
    options?: StorePauseOptions,
  ) {
    await this.status.setStoreOnline(tenantId, connectionId, open, {
      onlineAt: options?.until ?? null,
    });
    // JET answers with { ok, online, restaurant } and no trading word of its
    // own, so the raw value is what we asked for, not what it reported.
    const raw = open ? "ONLINE" : "OFFLINE";
    return { state: open ? ("OPEN" as const) : ("CLOSED" as const), raw };
  }

  async storeStatus(_tenantId: string, _connectionId: string): Promise<StoreStatus> {
    throw new StoreStatusUnavailableError(this.platform);
  }
}
