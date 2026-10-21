"use client";

// Phase AN — offline POS storage on IndexedDB (no external deps; native API).
//
// Two stores:
//   • menuCache  — the last-known active menu + modifier-group catalog per
//     location, so the POS still renders items/prices/86-state when the
//     network read fails.
//   • orderQueue — cash orders placed while offline, drained to the server by
//     sync-worker.ts on reconnect. Each row carries a stable `idempotencyKey`
//     (the local id) so a retry can never create a duplicate — the server's
//     `Order.idempotencyKey @unique` de-dupes end-to-end.
//
// localStorage still owns the small, synchronous cart draft (cart-storage.ts);
// bulk data (menu, queue) lives here.

const DB_NAME = "orderhub-pos";
const DB_VERSION = 1;
const MENU_STORE = "menuCache";
const QUEUE_STORE = "orderQueue";

export interface QueuedOrder {
  /** Local id, also sent as the server idempotencyKey. e.g. "local:<uuid>" */
  localId: string;
  locationId: string;
  /** The exact POST /v1/orders body built by the POS. */
  body: unknown;
  /** Amount, for display in the offline-queue UI. */
  total: number;
  customerName: string;
  queuedAt: number;
  status: "pending" | "syncing" | "synced" | "failed";
  /** Server order id once synced. */
  serverId?: string;
  /** Last error message when status === "failed". */
  error?: string;
  attempts: number;
  /**
   * Payment recorded while the order was already on its way to the server
   * (status "syncing"), so it couldn't go into `body`. The sync worker applies
   * it with PATCH /payment-status as soon as the order exists.
   */
  afterSync?: QueuedPayment;
  /** The kitchen ticket already printed on this device while offline. */
  printedLocally?: boolean;
}

/** A payment taken at the till for an order that is still only on this device. */
export interface QueuedPayment {
  paymentStatus: "PAID";
  paymentMethod: string;
  paymentProvider?: string;
}

interface MenuCacheRow {
  locationId: string;
  menu: unknown;
  modifierGroups?: unknown;
  cachedAt: number;
}

// Open ONCE and keep the connection open for the tab's lifetime. Opening +
// closing a connection per operation (as an earlier version did) let a close
// from one op abort another op's transaction / block the shared version, which
// could make a write hang forever — the POS "Place order" would just spin.
let dbPromise: Promise<IDBDatabase> | null = null;

function idb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      reject(new Error("IndexedDB unavailable"));
      return;
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(MENU_STORE)) {
        db.createObjectStore(MENU_STORE, { keyPath: "locationId" });
      }
      if (!db.objectStoreNames.contains(QUEUE_STORE)) {
        db.createObjectStore(QUEUE_STORE, { keyPath: "localId" });
      }
    };
    // Another tab holding an older version blocks our upgrade — surface it
    // instead of hanging silently.
    req.onblocked = () =>
      reject(new Error("IndexedDB blocked by another tab — close it and retry"));
    req.onsuccess = () => {
      const db = req.result;
      // If a versionchange comes from another tab, close so it isn't blocked.
      db.onversionchange = () => db.close();
      resolve(db);
    };
    req.onerror = () => {
      dbPromise = null; // let a later call retry a failed open
      reject(req.error ?? new Error("IndexedDB open failed"));
    };
  });
  return dbPromise;
}

function tx<T>(
  store: string,
  mode: IDBTransactionMode,
  run: (s: IDBObjectStore) => IDBRequest<T> | void,
): Promise<T | undefined> {
  return idb().then(
    (db) =>
      new Promise<T | undefined>((resolve, reject) => {
        const t = db.transaction(store, mode);
        const s = t.objectStore(store);
        let out: T | undefined;
        const r = run(s);
        if (r) r.onsuccess = () => (out = r.result);
        // Never close the shared connection here — it stays open for the tab.
        t.oncomplete = () => resolve(out);
        t.onerror = () => reject(t.error ?? new Error("IndexedDB tx failed"));
        t.onabort = () => reject(t.error ?? new Error("IndexedDB tx aborted"));
      }),
  );
}

// ── Menu cache ──────────────────────────────────────────────────────────────

export async function cacheMenu(
  locationId: string,
  menu: unknown,
  modifierGroups?: unknown,
): Promise<void> {
  try {
    const row: MenuCacheRow = {
      locationId,
      menu,
      modifierGroups,
      cachedAt: Date.now(),
    };
    await tx(MENU_STORE, "readwrite", (s) => s.put(row));
  } catch {
    /* caching is best-effort — never block the POS */
  }
}

export async function getCachedMenu(
  locationId: string,
): Promise<{ menu: unknown; modifierGroups?: unknown } | null> {
  try {
    const row = (await tx<MenuCacheRow>(MENU_STORE, "readonly", (s) =>
      s.get(locationId),
    )) as MenuCacheRow | undefined;
    return row ? { menu: row.menu, modifierGroups: row.modifierGroups } : null;
  } catch {
    return null;
  }
}

// ── Order queue ─────────────────────────────────────────────────────────────

export function newLocalId(): string {
  const uuid =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `local:${uuid}`;
}

export async function enqueueOrder(
  order: Omit<QueuedOrder, "status" | "attempts" | "queuedAt"> &
    Partial<Pick<QueuedOrder, "queuedAt">>,
): Promise<QueuedOrder> {
  const row: QueuedOrder = {
    status: "pending",
    attempts: 0,
    queuedAt: order.queuedAt ?? Date.now(),
    ...order,
  };
  await tx(QUEUE_STORE, "readwrite", (s) => s.put(row));
  return row;
}

export async function listQueue(): Promise<QueuedOrder[]> {
  try {
    const all = (await tx<QueuedOrder[]>(QUEUE_STORE, "readonly", (s) =>
      s.getAll(),
    )) as QueuedOrder[] | undefined;
    return (all ?? []).sort((a, b) => a.queuedAt - b.queuedAt);
  } catch {
    return [];
  }
}

export async function getQueued(localId: string): Promise<QueuedOrder | undefined> {
  return (await tx<QueuedOrder>(QUEUE_STORE, "readonly", (s) =>
    s.get(localId),
  )) as QueuedOrder | undefined;
}

/**
 * Read-modify-write one queued row inside a SINGLE transaction. Separate read
 * and write transactions let the sync worker and the till interleave (the
 * till recording a cash payment while the worker flips the row to "syncing"),
 * and whichever wrote last silently undid the other.
 */
export async function mutateQueued(
  localId: string,
  fn: (row: QueuedOrder) => QueuedOrder,
): Promise<QueuedOrder | undefined> {
  let next: QueuedOrder | undefined;
  await tx(QUEUE_STORE, "readwrite", (s) => {
    const get = s.get(localId);
    get.onsuccess = () => {
      const row = get.result as QueuedOrder | undefined;
      if (!row) return;
      next = fn(row);
      s.put(next);
    };
  });
  return next;
}

export async function updateQueued(
  localId: string,
  patch: Partial<QueuedOrder>,
): Promise<void> {
  await mutateQueued(localId, (row) => ({ ...row, ...patch }));
}

/**
 * Record a payment taken at the till against an order that may still be on
 * this device.
 *
 *  • still queued      → written into the body, so it syncs already paid;
 *  • mid-sync          → parked on `afterSync` for the worker to apply;
 *  • already synced    → returns the server id; the caller PATCHes it online.
 *  • unknown           → returns { missing: true }.
 */
export async function settleQueued(
  localId: string,
  payment: QueuedPayment,
): Promise<{ queued: true } | { serverId: string } | { missing: true }> {
  const row = await mutateQueued(localId, (r) =>
    r.status === "syncing"
      ? { ...r, afterSync: payment }
      : {
          ...r,
          body: { ...(r.body as Record<string, unknown>), ...payment },
        },
  );
  if (row) return { queued: true };
  const serverId = syncedServerId(localId);
  return serverId ? { serverId } : { missing: true };
}

// ── Local id → server id ────────────────────────────────────────────────────
// A synced row is deleted from the queue, but the till may still be holding
// its local id (the cash keypad left open across the reconnect). Kept small
// and in localStorage: it only has to outlive a reconnect, not a week.

const SYNCED_KEY = "orderhub-pos:synced-ids";
const SYNCED_MAX = 50;

function readSynced(): Array<[string, string]> {
  try {
    const raw = localStorage.getItem(SYNCED_KEY);
    return raw ? (JSON.parse(raw) as Array<[string, string]>) : [];
  } catch {
    return [];
  }
}

export function rememberSynced(localId: string, serverId: string): void {
  try {
    const next = readSynced().filter(([l]) => l !== localId);
    next.push([localId, serverId]);
    localStorage.setItem(SYNCED_KEY, JSON.stringify(next.slice(-SYNCED_MAX)));
  } catch {
    /* best-effort */
  }
}

export function syncedServerId(localId: string): string | undefined {
  return readSynced().find(([l]) => l === localId)?.[1];
}

export async function removeQueued(localId: string): Promise<void> {
  await tx(QUEUE_STORE, "readwrite", (s) => s.delete(localId));
}

/** Count of orders still waiting to reach the server. */
export async function pendingCount(): Promise<number> {
  const all = await listQueue();
  return all.filter((o) => o.status === "pending" || o.status === "failed")
    .length;
}
