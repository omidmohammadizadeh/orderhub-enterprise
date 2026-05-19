import { Injectable } from "@nestjs/common";
import axios, { AxiosInstance } from "axios";
import type { OrderStatus } from "@orderhub/database";

export interface SyncResult {
  success: boolean;
  platformOrderId?: string;
  error?: string;
  rateLimited?: boolean;
  retryAfterMs?: number;
}

/** Parse a Retry-After header value into milliseconds.
 *  Accepts integer seconds ("30") or an HTTP-date ("Wed, 21 Oct 2026 07:28:00 GMT").
 *  Returns null when the header is absent or unparseable. */
export function parseRetryAfterMs(headers: Record<string, string | undefined>): number | null {
  const raw = headers["retry-after"] ?? headers["Retry-After"];
  if (!raw) return null;

  const seconds = Number(raw);
  if (!isNaN(seconds) && seconds >= 0) return Math.ceil(seconds) * 1000;

  const date = new Date(raw);
  if (!isNaN(date.getTime())) {
    const delay = date.getTime() - Date.now();
    return delay > 0 ? delay : 0;
  }

  return null;
}

// Base contract for all outbound platform sync clients.
export abstract class PlatformSyncClient {
  abstract readonly platform: string;
  // Sends the new order status to the external platform.
  abstract syncStatus(
    externalId: string,
    newStatus: OrderStatus,
    credentials: Record<string, string>,
    opts?: { cancelReason?: string },
  ): Promise<SyncResult>;
}

// ── Uber Eats ──────────────────────────────────────────────
// Status mapping: ACCEPTED → accept, READY → ready_for_pickup, CANCELLED → cancel
@Injectable()
export class UberEatsSyncClient extends PlatformSyncClient {
  readonly platform = "UBER_EATS";

  private client(credentials: Record<string, string>): AxiosInstance {
    return axios.create({
      baseURL: "https://api.uber.com/v1/eats/restaurants",
      headers: {
        Authorization: `Bearer ${credentials.accessToken}`,
        "Content-Type": "application/json",
      },
      timeout: 10_000,
    });
  }

  async syncStatus(
    externalId: string,
    newStatus: OrderStatus,
    credentials: Record<string, string>,
    opts: { cancelReason?: string } = {},
  ): Promise<SyncResult> {
    const http = this.client(credentials);
    try {
      if (newStatus === "ACCEPTED") {
        await http.post(`/orders/${externalId}/accept_pos_order`, {
          reason: "Order accepted",
        });
      } else if (newStatus === "READY") {
        await http.post(`/orders/${externalId}/ready_for_pickup`);
      } else if (newStatus === "CANCELLED" || newStatus === "REJECTED") {
        await http.post(`/orders/${externalId}/cancel`, {
          reason: opts.cancelReason ?? "cancelled_by_restaurant",
        });
      } else {
        // PREPARING, DISPATCHED, COMPLETED — no Uber Eats API call needed
        return { success: true };
      }
      return { success: true };
    } catch (err: any) {
      if (err?.response?.status === 429) {
        const retryAfterMs = parseRetryAfterMs(err.response.headers ?? {});
        return { success: false, error: "RATE_LIMITED", rateLimited: true, retryAfterMs: retryAfterMs ?? undefined };
      }
      return { success: false, error: err?.response?.data?.message ?? String(err) };
    }
  }
}

// ── Deliveroo ─────────────────────────────────────────────
@Injectable()
export class DeliverooSyncClient extends PlatformSyncClient {
  readonly platform = "DELIVEROO";

  private client(credentials: Record<string, string>): AxiosInstance {
    return axios.create({
      baseURL: "https://api.deliveroo.com/order-api/v1",
      headers: {
        Authorization: `Bearer ${credentials.accessToken}`,
        "Content-Type": "application/json",
      },
      timeout: 10_000,
    });
  }

  async syncStatus(
    externalId: string,
    newStatus: OrderStatus,
    credentials: Record<string, string>,
    opts: { cancelReason?: string } = {},
  ): Promise<SyncResult> {
    const http = this.client(credentials);
    try {
      if (newStatus === "ACCEPTED") {
        await http.put(`/orders/${externalId}`, { status: "accepted" });
      } else if (newStatus === "READY") {
        await http.put(`/orders/${externalId}`, { status: "ready" });
      } else if (newStatus === "CANCELLED" || newStatus === "REJECTED") {
        await http.put(`/orders/${externalId}`, {
          status: "rejected",
          reject_reason: opts.cancelReason ?? "KITCHEN_CLOSED",
        });
      } else {
        return { success: true };
      }
      return { success: true };
    } catch (err: any) {
      if (err?.response?.status === 429) {
        const retryAfterMs = parseRetryAfterMs(err.response.headers ?? {});
        return { success: false, error: "RATE_LIMITED", rateLimited: true, retryAfterMs: retryAfterMs ?? undefined };
      }
      return { success: false, error: err?.response?.data?.message ?? String(err) };
    }
  }
}

// ── Just Eat ──────────────────────────────────────────────
@Injectable()
export class JustEatSyncClient extends PlatformSyncClient {
  readonly platform = "JUST_EAT";

  private static readonly BASE_URL = "https://uk-api.just-eat.io";

  private client(credentials: Record<string, string>): AxiosInstance {
    return axios.create({
      baseURL: JustEatSyncClient.BASE_URL,
      headers: {
        Authorization: `Bearer ${credentials.accessToken}`,
        "Content-Type": "application/json",
        ...(credentials.applicationId
          ? { "x-je-application-id": credentials.applicationId }
          : {}),
      },
      timeout: 10_000,
    });
  }

  async syncStatus(
    externalId: string,
    newStatus: OrderStatus,
    credentials: Record<string, string>,
    opts: { cancelReason?: string } = {},
  ): Promise<SyncResult> {
    const http = this.client(credentials);
    try {
      if (newStatus === "ACCEPTED") {
        const dueDate = new Date(Date.now() + 30 * 60_000).toISOString();
        await http.put(`/orders/${externalId}/accept`, { dueDate });
      } else if (newStatus === "REJECTED" || newStatus === "CANCELLED") {
        await http.put(`/orders/${externalId}/reject`, {
          reason: opts.cancelReason ?? "RestaurantClosed",
        });
      } else if (newStatus === "READY") {
        await http.put(`/orders/${externalId}/ready`);
      } else {
        // PREPARING, DISPATCHED, COMPLETED — no Just Eat API call needed
        return { success: true };
      }
      return { success: true };
    } catch (err: any) {
      if (err?.response?.status === 429) {
        const retryAfterMs = parseRetryAfterMs(err.response.headers ?? {});
        return { success: false, error: "RATE_LIMITED", rateLimited: true, retryAfterMs: retryAfterMs ?? undefined };
      }
      return { success: false, error: err?.response?.data?.message ?? String(err) };
    }
  }
}

// ── HubRise ───────────────────────────────────────────────
// HubRise normalises across multiple platforms — update the order status
// in HubRise and it propagates to the origin platform.
@Injectable()
export class HubRiseSyncClient extends PlatformSyncClient {
  readonly platform = "HUBRISE";

  private static readonly STATUS_MAP: Partial<Record<OrderStatus, string>> = {
    ACCEPTED: "accepted",
    PREPARING: "in_preparation",
    READY: "ready_for_pickup",
    DISPATCHED: "in_delivery",
    COMPLETED: "completed",
    CANCELLED: "cancelled",
    REJECTED: "rejected",
  };

  private client(credentials: Record<string, string>): AxiosInstance {
    return axios.create({
      baseURL: "https://api.hubrise.com/v1",
      headers: {
        "X-Access-Token": credentials.accessToken,
        "Content-Type": "application/json",
      },
      timeout: 10_000,
    });
  }

  async syncStatus(
    externalId: string,
    newStatus: OrderStatus,
    credentials: Record<string, string>,
    opts: { cancelReason?: string } = {},
  ): Promise<SyncResult> {
    const hubriseStatus = HubRiseSyncClient.STATUS_MAP[newStatus];
    if (!hubriseStatus) return { success: true };

    const http = this.client(credentials);
    try {
      await http.patch(
        `/accounts/${credentials.accountId}/locations/${credentials.locationId}/orders/${externalId}`,
        { status: hubriseStatus },
      );
      return { success: true };
    } catch (err: any) {
      if (err?.response?.status === 429) {
        const retryAfterMs = parseRetryAfterMs(err.response.headers ?? {});
        return { success: false, error: "RATE_LIMITED", rateLimited: true, retryAfterMs: retryAfterMs ?? undefined };
      }
      return { success: false, error: err?.response?.data?.message ?? String(err) };
    }
  }
}

// ── Factory ────────────────────────────────────────────────
@Injectable()
export class PlatformSyncFactory {
  private readonly clients: Map<string, PlatformSyncClient> = new Map();

  constructor(
    uberEats: UberEatsSyncClient,
    deliveroo: DeliverooSyncClient,
    justEat: JustEatSyncClient,
    hubRise: HubRiseSyncClient,
  ) {
    this.clients.set("UBER_EATS", uberEats);
    this.clients.set("DELIVEROO", deliveroo);
    this.clients.set("JUST_EAT", justEat);
    this.clients.set("HUBRISE", hubRise);
  }

  get(platform: string): PlatformSyncClient | undefined {
    return this.clients.get(platform);
  }
}
