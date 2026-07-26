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
}

interface MenuCacheRow {
  locationId: string;
  menu: unknown;
  modifierGroups?: unknown;
  cachedAt: number;
}

function idb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
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
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("IndexedDB open failed"));
  });
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
        t.oncomplete = () => {
          db.close();
          resolve(out);
        };
        t.onerror = () => {
          db.close();
          reject(t.error ?? new Error("IndexedDB tx failed"));
        };
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

export async function updateQueued(
  localId: string,
  patch: Partial<QueuedOrder>,
): Promise<void> {
  const existing = (await tx<QueuedOrder>(QUEUE_STORE, "readonly", (s) =>
    s.get(localId),
  )) as QueuedOrder | undefined;
  if (!existing) return;
  await tx(QUEUE_STORE, "readwrite", (s) => s.put({ ...existing, ...patch }));
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
