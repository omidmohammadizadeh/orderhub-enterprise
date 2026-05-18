import { Injectable, Logger } from "@nestjs/common";
import { Server } from "socket.io";
import type {
  ServerToClientEvents,
  OrderEventPayload,
  IntegrationStatusPayload,
} from "@orderhub/shared";

// SocketService is the single emission point for real-time events.
// All domain modules inject this service instead of holding a Server reference.
@Injectable()
export class SocketService {
  private readonly logger = new Logger(SocketService.name);
  private server: Server | null = null;

  setServer(server: Server) {
    this.server = server;
  }

  // Emit to all clients subscribed to a location room
  emitToLocation<K extends keyof ServerToClientEvents>(
    locationId: string,
    event: K,
    payload: Parameters<ServerToClientEvents[K]>[0],
  ) {
    if (!this.server) {
      this.logger.warn("Socket server not initialised yet");
      return;
    }
    this.server.to(`location:${locationId}`).emit(event as string, payload);
  }

  // Emit to all clients in a tenant room (e.g. analytics dashboards)
  emitToTenant<K extends keyof ServerToClientEvents>(
    tenantId: string,
    event: K,
    payload: Parameters<ServerToClientEvents[K]>[0],
  ) {
    if (!this.server) return;
    this.server.to(`tenant:${tenantId}`).emit(event as string, payload);
  }

  emitNewOrder(locationId: string, payload: OrderEventPayload) {
    this.emitToLocation(locationId, "order:new", payload);
    this.logger.debug(`Emitted order:new → location:${locationId}`);
  }

  emitOrderUpdated(locationId: string, payload: OrderEventPayload) {
    this.emitToLocation(locationId, "order:updated", payload);
  }

  emitIntegrationStatus(locationId: string, payload: IntegrationStatusPayload) {
    this.emitToLocation(locationId, "integration:status", payload);
  }
}
