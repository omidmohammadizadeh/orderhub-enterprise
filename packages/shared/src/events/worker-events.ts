// Redis pub/sub channel for worker → API socket bridge.
// The worker publishes typed events here; the API's RedisSubscriberService
// relays them to the Socket.IO gateway so clients see real-time updates.

export const WORKER_EVENTS_CHANNEL = "orderhub:worker-events" as const;

export type WorkerEventType =
  | "order:new"
  | "order:updated"
  | "order:cancelled"
  | "print:job"
  | "integration:status"
  | "kds:order:new"
  | "kds:ticket:bumped";

export interface WorkerEvent<T = unknown> {
  type: WorkerEventType;
  locationId: string;
  tenantId: string;
  payload: T;
  emittedAt: string;
}
