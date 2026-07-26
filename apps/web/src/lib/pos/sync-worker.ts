"use client";

// Phase AN — drains the offline order queue to the server when back online.
//
// Each queued order is POSTed to /v1/orders with `idempotencyKey` = its local
// id. The server's unique idempotencyKey index means a retry (or a drain that
// races with a tab that reconnected first) can never create a duplicate — a
// P2002/409 just returns the existing order, which we treat as success.
//
// Offline orders are cash-only (Phase 1), so each synced order is auto-accepted
// exactly like an online cash order (see pos/page.tsx), swallowing the
// "ACCEPTED → ACCEPTED" response locations with auto-accept produce.

import { apiClient } from "@/lib/api/client";
import {
  listQueue,
  removeQueued,
  updateQueued,
  type QueuedOrder,
} from "./idb-storage";

let draining = false;

async function syncOne(order: QueuedOrder): Promise<void> {
  await updateQueued(order.localId, { status: "syncing" });
  try {
    const body = {
      ...(order.body as Record<string, unknown>),
      idempotencyKey: order.localId,
    };
    const created = (await apiClient.post("/v1/orders", body)).data as {
      id: string;
    };

    // Auto-accept (cash order) — best-effort, mirror the online path.
    try {
      await apiClient.patch(`/v1/orders/${created.id}/status`, {
        status: "ACCEPTED",
        note: "POS offline sync",
      });
    } catch (err: any) {
      const msg = String(err?.response?.data?.message ?? "");
      if (!/ACCEPTED\s*(→|->|to)\s*ACCEPTED|already/i.test(msg)) throw err;
    }

    await removeQueued(order.localId);
  } catch (err: any) {
    // A duplicate (server already has this idempotencyKey) is success.
    const status = err?.response?.status;
    if (status === 409) {
      await removeQueued(order.localId);
      return;
    }
    // 4xx (other than 409) = a payload the server rejects — flag for the
    // operator; don't retry forever. 5xx / network = leave pending to retry.
    const permanent = typeof status === "number" && status >= 400 && status < 500;
    await updateQueued(order.localId, {
      status: permanent ? "failed" : "pending",
      attempts: (order.attempts ?? 0) + 1,
      error: String(err?.response?.data?.message ?? err?.message ?? "sync failed"),
    });
    if (!permanent) throw err; // stop the drain on transient errors; retry later
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
      if (order.status === "synced") continue;
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

let started = false;
/** Wire the drain to reconnects + a slow safety-net interval. Idempotent. */
export function startSyncWorker(): () => void {
  if (typeof window === "undefined") return () => {};
  const onOnline = () => void drainQueue();
  if (!started) {
    started = true;
    window.addEventListener("online", onOnline);
    void drainQueue(); // catch anything queued before this mount
  }
  const interval = window.setInterval(() => void drainQueue(), 30_000);
  return () => {
    window.removeEventListener("online", onOnline);
    window.clearInterval(interval);
    started = false;
  };
}
