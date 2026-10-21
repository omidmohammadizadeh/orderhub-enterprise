import { beforeEach, describe, expect, it, vi } from "vitest";
import type { QueuedOrder } from "./idb-storage";

// The queue lives in IndexedDB in the browser; here it is a Map behind the
// same functions, so the worker's decisions are what's under test.
const rows = new Map<string, QueuedOrder>();
const synced = new Map<string, string>();

vi.mock("./idb-storage", () => ({
  listQueue: async () => [...rows.values()].sort((a, b) => a.queuedAt - b.queuedAt),
  getQueued: async (id: string) => rows.get(id),
  updateQueued: async (id: string, patch: Partial<QueuedOrder>) => {
    const r = rows.get(id);
    if (r) rows.set(id, { ...r, ...patch });
  },
  removeQueued: async (id: string) => void rows.delete(id),
  rememberSynced: (l: string, s: string) => void synced.set(l, s),
}));

const post = vi.fn();
const patch = vi.fn();
vi.mock("@/lib/api/client", () => ({
  apiClient: { post: (...a: unknown[]) => post(...a), patch: (...a: unknown[]) => patch(...a) },
}));
const markOrderPrinted = vi.fn(async () => null);
vi.mock("@/lib/api/printers.client", () => ({
  printersClient: { markOrderPrinted: (...a: unknown[]) => markOrderPrinted(...(a as [])) },
}));

const { drainQueue, retryFailed } = await import("./sync-worker");

function queue(localId: string, body: Record<string, unknown>, extra: Partial<QueuedOrder> = {}) {
  rows.set(localId, {
    localId,
    locationId: "loc-1",
    body: { locationId: "loc-1", items: [], subtotal: 10, total: 10, ...body },
    total: 10,
    customerName: "Walk-in",
    queuedAt: rows.size + 1,
    status: "pending",
    attempts: 0,
    ...extra,
  });
}

const httpError = (status: number, message = "nope") =>
  Object.assign(new Error(message), { response: { status, data: { message } } });

beforeEach(() => {
  rows.clear();
  synced.clear();
  post.mockReset();
  patch.mockReset();
  markOrderPrinted.mockClear();
  post.mockImplementation(async (_url: string, body: any) => ({
    data: { id: `srv-${body.idempotencyKey}` },
  }));
  patch.mockResolvedValue({ data: {} });
  Object.defineProperty(navigator, "onLine", { value: true, configurable: true });
});

describe("drainQueue", () => {
  it("creates with the local id as idempotencyKey, accepts, and clears the row", async () => {
    queue("local:a", { paymentMethod: "PAY_ON_COLLECTION", paymentStatus: "PENDING" });
    await drainQueue();
    const [, body] = post.mock.calls[0]!;
    expect(body.idempotencyKey).toBe("local:a");
    expect(body.offline.ref).toMatch(/^OFF-/);
    expect(body.offline.takenAt).toBeTruthy();
    expect(patch).toHaveBeenCalledWith("/v1/orders/srv-local:a/status", expect.objectContaining({ status: "ACCEPTED" }));
    expect(rows.size).toBe(0);
    expect(synced.get("local:a")).toBe("srv-local:a");
  });

  it("does NOT accept an order the till never got paid for", async () => {
    // Walk-in cash closed without settling: online it waits in "Waiting for
    // payment"; synced from offline it must do exactly the same.
    queue("local:b", { paymentMethod: "CASH", paymentStatus: "PENDING", isWalkIn: true });
    await drainQueue();
    expect(post).toHaveBeenCalledTimes(1);
    expect(patch).not.toHaveBeenCalled();
    expect(rows.size).toBe(0);
  });

  it("applies a payment taken while the order was mid-sync", async () => {
    queue("local:c", { paymentMethod: "CARD_TERMINAL", paymentStatus: "PENDING" });
    post.mockImplementationOnce(async (_u: string, body: any) => {
      // The operator taps "Approved" while the POST is in flight.
      rows.set("local:c", {
        ...rows.get("local:c")!,
        afterSync: { paymentStatus: "PAID", paymentMethod: "CARD_TERMINAL", paymentProvider: "MANUAL" },
      });
      return { data: { id: `srv-${body.idempotencyKey}` } };
    });
    await drainQueue();
    expect(patch).toHaveBeenNthCalledWith(1, "/v1/orders/srv-local:c/payment-status", {
      paymentStatus: "PAID",
      paymentMethod: "CARD_TERMINAL",
      paymentProvider: "MANUAL",
    });
    // Paid now, so it goes to the kitchen.
    expect(patch).toHaveBeenNthCalledWith(2, "/v1/orders/srv-local:c/status", expect.anything());
  });

  it("tells the server the ticket already printed, and clears its print job", async () => {
    queue("local:d", { paymentMethod: "CASH", paymentStatus: "PAID", isWalkIn: true }, { printedLocally: true });
    await drainQueue();
    expect(post.mock.calls[0]![1].offline.printedLocally).toBe(true);
    expect(markOrderPrinted).toHaveBeenCalledWith("srv-local:d");
  });

  it("swallows 'already accepted' from auto-accept locations", async () => {
    queue("local:e", { paymentMethod: "CASH", paymentStatus: "PAID", isWalkIn: true });
    patch.mockRejectedValueOnce(httpError(400, "Invalid transition ACCEPTED → ACCEPTED"));
    await drainQueue();
    expect(rows.size).toBe(0);
  });

  it("keeps retrying an expired login or a rate limit instead of parking the order", async () => {
    queue("local:f", { paymentMethod: "CASH", paymentStatus: "PAID" });
    queue("local:g", { paymentMethod: "CASH", paymentStatus: "PAID" });
    post.mockRejectedValueOnce(httpError(401));
    await drainQueue();
    expect(rows.get("local:f")?.status).toBe("pending");
    // A transient failure stops the pass; the order behind it waits its turn.
    expect(post).toHaveBeenCalledTimes(1);
    post.mockRejectedValueOnce(httpError(429));
    await drainQueue();
    expect(rows.get("local:f")?.status).toBe("pending");
    await drainQueue();
    expect(rows.size).toBe(0);
  });

  it("parks a payload the server rejects, and carries on with the rest", async () => {
    queue("local:h", { paymentMethod: "CASH" });
    queue("local:i", { paymentMethod: "CASH" });
    post.mockRejectedValueOnce(httpError(400, "items must be an array"));
    await drainQueue();
    expect(rows.get("local:h")).toMatchObject({ status: "failed", error: "items must be an array" });
    expect(rows.has("local:i")).toBe(false);
    // Parked rows are skipped by the automatic drain…
    await drainQueue();
    expect(post).toHaveBeenCalledTimes(2);
    // …and go back in line on "Retry now".
    await retryFailed();
    expect(rows.size).toBe(0);
  });

  it("never parks an order that was created but whose accept failed", async () => {
    // The order exists on the server. Parking it as "failed" would hide it;
    // the next pass re-POSTs (the server returns the same order) and accepts.
    queue("local:j", { paymentMethod: "PAY_ON_COLLECTION" });
    patch.mockRejectedValueOnce(httpError(403, "Forbidden"));
    await drainQueue();
    expect(rows.get("local:j")?.status).toBe("pending");
    await drainQueue();
    expect(post).toHaveBeenCalledTimes(2);
    expect(post.mock.calls[1]![1].idempotencyKey).toBe("local:j");
    expect(rows.size).toBe(0);
  });

  it("re-sends without the offline stamp to an API that predates it", async () => {
    queue("local:m", { paymentMethod: "CASH", paymentStatus: "PAID" });
    post.mockRejectedValueOnce(
      Object.assign(new Error("Bad Request"), {
        response: { status: 400, data: { message: ["property offline should not exist"] } },
      }),
    );
    await drainQueue();
    expect(post).toHaveBeenCalledTimes(2);
    expect(post.mock.calls[1]![1].offline).toBeUndefined();
    expect(post.mock.calls[1]![1].idempotencyKey).toBe("local:m");
    expect(rows.size).toBe(0);
  });

  it("does nothing while the browser is offline", async () => {
    Object.defineProperty(navigator, "onLine", { value: false, configurable: true });
    queue("local:k", { paymentMethod: "CASH" });
    await drainQueue();
    expect(post).not.toHaveBeenCalled();
  });
});
