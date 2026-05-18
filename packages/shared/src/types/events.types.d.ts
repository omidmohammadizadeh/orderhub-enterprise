export interface ServerToClientEvents {
    "order:new": (payload: OrderEventPayload) => void;
    "order:updated": (payload: OrderEventPayload) => void;
    "order:cancelled": (payload: OrderCancelledPayload) => void;
    "kds:bump": (payload: KdsBumpPayload) => void;
    "integration:status": (payload: IntegrationStatusPayload) => void;
    "printer:status": (payload: PrinterStatusPayload) => void;
}
export interface ClientToServerEvents {
    "room:join": (locationId: string) => void;
    "room:leave": (locationId: string) => void;
    "order:accept": (orderId: string) => void;
    "kds:bump": (ticketId: string) => void;
}
export interface OrderEventPayload {
    orderId: string;
    locationId: string;
    platform: string;
    displayId: string | null;
    status: string;
    total: number;
    itemCount: number;
    customerName: string;
    type: string;
    scheduledFor: string | null;
    createdAt: string;
}
export interface OrderCancelledPayload {
    orderId: string;
    locationId: string;
    reason: string | null;
    cancelledAt: string;
}
export interface KdsBumpPayload {
    ticketId: string;
    orderId: string;
    kdsScreenId: string;
    bumpedAt: string;
}
export interface IntegrationStatusPayload {
    locationId: string;
    platform: string;
    status: "ACTIVE" | "INACTIVE" | "ERROR";
    message?: string;
}
export interface PrinterStatusPayload {
    printerId: string;
    locationId: string;
    isOnline: boolean;
}
//# sourceMappingURL=events.types.d.ts.map