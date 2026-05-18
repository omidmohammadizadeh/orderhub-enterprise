import {
  WebSocketGateway,
  WebSocketServer,
  SubscribeMessage,
  MessageBody,
  ConnectedSocket,
} from "@nestjs/websockets";
import { Logger } from "@nestjs/common";
import { Server, Socket } from "socket.io";
import type { ClientToServerEvents, ServerToClientEvents } from "@orderhub/shared";

type TypedSocket = Socket<ClientToServerEvents, ServerToClientEvents>;

// Separate namespace for KDS screens — keeps KDS traffic isolated
// so a noisy orders flow doesn't affect KDS rendering latency.
@WebSocketGateway({
  namespace: "/kds",
  cors: {
    origin: process.env.SOCKET_CORS_ORIGIN ?? "http://localhost:3000",
    credentials: true,
  },
})
export class KdsGateway {
  @WebSocketServer()
  server!: Server;

  private readonly logger = new Logger(KdsGateway.name);

  @SubscribeMessage("room:join")
  handleJoin(
    @ConnectedSocket() client: TypedSocket,
    @MessageBody() locationId: string,
  ) {
    client.join(`kds:${locationId}`);
    this.logger.debug(`KDS screen ${client.id} joined kds:${locationId}`);
  }

  @SubscribeMessage("kds:bump")
  handleBump(
    @ConnectedSocket() client: TypedSocket,
    @MessageBody() ticketId: string,
  ) {
    // Forward the bump to other KDS screens at the same location
    // so multi-screen stations stay in sync
    const rooms = Array.from(client.rooms).filter((r) => r.startsWith("kds:"));
    rooms.forEach((room) => {
      client.to(room).emit("kds:bump", {
        ticketId,
        orderId: "",     // Resolved by the Orders service after DB write
        kdsScreenId: "",
        bumpedAt: new Date().toISOString(),
      });
    });
  }
}
