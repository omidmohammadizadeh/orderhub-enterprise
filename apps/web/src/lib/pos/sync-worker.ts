"use client";

// Phase AN — drains the offline order queue to the server when back online.
//
// Each queued order is POSTed to /v1/orders with `idempotencyKey` = its local
// id. The server's unique idempotencyKey index means a retry (or a drain that
// races with a tab that reconnected first) can never create a duplicate — the
// second POST returns the order the first one made, which we treat as success.
//
// After creating, each order is handled exactly like the online placement
// (pos/page.tsx): accepted, unless the till is still collecting for it, in
// which case it waits in "Waiting for payment" exactly as it would have.

import { apiClient } from "@/lib/api/client";
import { printersClient } from "@/lib/api/printers.client";
import {
  getQueued,
  listQueue,
  rememberSynced,
  removeQueued,
  updateQueued,
  type QueuedOrder,
} from "./idb-storage";
import {
  holdsForPayment,
  isRetryableSyncError,
  offlineRef,
  type QueuedOrderBody,
} from "./offline-policy";

let draining = false;

async function acceptOrder(serverId: string): Promise<void> {
  try {
    await apiClient.patch(`/v1/orders/${serverId}/status`, {
      status: "ACCEPTED",
      note: "POS offline sync",
    });
  } catch (err: any) {
    const msg = String(err?.response?.data?.message ?? "");
    // Auto-accept locations (and a counter sale the server already completed)
    // answer "already" — same outcome.
    if (!/(ACCEPTED|COMPLETED)\s*(→|->|to)\s*ACCEPTED|already/i.test(msg)) throw err;
  }
}

/**
 * POST the queued order. An API older than this till (Render rolls the web app
 * and the API out separately) refuses the `offline` field outright — the
 * validator forbids unknown properties — so re-send without it rather than
 * park a perfectly good order. Same idempotencyKey, so never a duplicate.
 */
async function createOrder(order: QueuedOrder, body: QueuedOrderBody): Promise<{ id: string }> {
  const payload = { ...body, idempotencyKey: order.localId };
  try {
    return (
      await apiClient.post("/v1/orders", {
        ...payload,
        offline: {
          takenAt: new Date(order.queuedAt).toISOString(),
          ref: offlineRef(order.localId),
          ...(order.printedLocally ? { printedLocally: true } : {}),
        },
      })
    ).data as { id: string };
  } catch (err: any) {
    const message = JSON.stringify(err?.response?.data?.message ?? "");
    if (err?.response?.status !== 400 || !/property offline should not exist/.test(message)) {
      throw err;
    }
    return (await apiClient.post("/v1/orders", payload)).data as { id: string };
  }
}

async function syncOne(order: QueuedOrder): Promise<void> {
  await updateQueued(order.localId, { status: "syncing" });
  const body = order.body as QueuedOrderBody;
  let serverId: string | null = null;
  try {
    const created = await createOrder(order, body);
    serverId = created.id;
    rememberSynced(order.localId, serverId);

    // A payment taken while this POST was in flight. Settling flips a held
    // order to PAID, and the server accepts + prints it from there.
    const late = (await getQueued(order.localId))?.afterSync;
    if (late) {
      await apiClient.patch(`/v1/orders/${serverId}/payment-status`, late);
    }

    const paid = late ? { ...body, ...late } : body;
    if (!holdsForPayment(paid)) await acceptOrder(serverId);

    // The kitchen already has this ticket from the offline print — clear the
    // server's print job so a desktop print agent doesn't print it again.
    if (order.printedLocally) void printersClient.markOrderPrinted(serverId).catch(() => {});

    await removeQueued(order.localId);
  } catch (err: any) {
    const status = err?.response?.status as number | undefined;
    // Created but the follow-up failed: the order exists, so never park it as
    // "failed" — the next pass re-POSTs (idempotent) and retries the rest.
    const retry = serverId !== null || isRetryableSyncError(status);
    await updateQueued(order.localId, {
      status: retry ? "pending" : "failed",
      attempts: (order.attempts ?? 0) + 1,
      error: String(err?.response?.data?.message ?? err?.message ?? "sync failed"),
    });
    if (retry) throw err; // stop the drain on transient errors; retry later
  }
}

/** Drain all pending orders. Safe to call repeatedly; serialises itself. */
export async function drainQueue(): Promise<void> {
  if (draining) return;
  if (typeof navigator !== "undefined" && !navigator.onLine) return;
  draining = true;
  try {
    const queue = await listQueue();
    for (const order of queue) {
      // Parked orders wait for the operator ("Retry" in the queue list).
      if (order.status === "synced" || order.status === "failed") continue;
      try {
        await syncOne(order);
      } catch {
        // Transient failure — stop this pass; the 'online' listener or the
        // next interval will retry the remaining orders.
        break;
      }
    }
  } finally {
    draining = false;
  }
}

/** Put parked orders back in line and drain. */
export async function retryFailed(): Promise<void> {
  for (const o of await listQueue()) {
    if (o.status === "failed") await updateQueued(o.localId, { status: "pending" });
  }
  await drainQueue();
}

/**
 * A row left "syncing" by a tab that closed mid-request would otherwise never
 * be picked up again. Nothing is in flight at startup, so any such row is
 * safe to return to the queue — the idempotency key makes a re-POST harmless.
 */
async function recoverStuck(): Promise<void> {
  if (draining) return; // a remount mid-drain: that row IS in flight
  for (const o of await listQueue()) {
    if (o.status === "syncing") await updateQueued(o.localId, { status: "pending" });
  }
}

let started = false;
/** Wire the drain to reconnects + a slow safety-net interval. Idempotent. */
export function startSyncWorker(): () => void {
  if (typeof window === "undefined") return () => {};
  const onOnline = () => void drainQueue();
  if (!started) {
    started = true;
    window.addEventListener("online", onOnline);
    void recoverStuck().then(drainQueue); // catch anything queued before this mount
  }
  const interval = window.setInterval(() => void drainQueue(), 30_000);
  return () => {
    window.removeEventListener("online", onOnline);
    window.clearInterval(interval);
    started = false;
  };
}
