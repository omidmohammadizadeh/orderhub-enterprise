// A Dojo Pay at Table payment lock, stored on Order.metadata.dojoLock while a
// card machine is taking payment for the table. Its own file so OrdersService
// can check it without importing the payments module graph.

export interface DojoLock {
  lockId: string;
  expiry: string;
}

/** The lock, if one is held and hasn't expired. A stale lock is no lock. */
export function activeDojoLock(metadata: unknown): DojoLock | null {
  const lock = ((metadata ?? {}) as Record<string, any>).dojoLock as DojoLock | undefined;
  if (!lock?.lockId || !lock.expiry) return null;
  return new Date(lock.expiry).getTime() > Date.now() ? lock : null;
}
