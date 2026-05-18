import {
  WebSocketGateway,
  WebSocketServer,
  SubscribeMessage,
  OnGatewayInit,
  OnGatewayConnection,
  OnGatewayDisconnect,
  MessageBody,
  ConnectedSocket,
} from "@nestjs/websockets";
import { UseGuards, Logger } from "@nestjs/common";
import { Server, Socket } from "socket.io";
import { SocketService } from "../socket.service";
import type { ClientToServerEvents, ServerToClientEvents } from "@orderhub/shared";

type TypedServer = Server<ClientToServerEvents, ServerToClientEvents>;
type TypedSocket = Socket<ClientToServerEvents, ServerToClientEvents>;

@WebSocketGateway({
  cors: {
    origin: process.env.SOCKET_CORS_ORIGIN ?? "http://localhost:3000",
    credentials: true,
  },
  namespace: "/",
  transports: ["websocket", "polling"],
})
export class OrdersGateway
  implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect
{
  @WebSocketServer()
  server!: TypedServer;

  private readonly logger = new Logger(OrdersGateway.name);

  constructor(private readonly socketService: SocketService) {}

  afterInit(server: TypedServer) {
    this.socketService.setServer(server as unknown as Server);
    this.logger.log("WebSocket gateway initialised");
  }

  handleConnection(client: TypedSocket) {
    this.logger.debug(`Client connected: ${client.id}`);
  }

  handleDisconnect(client: TypedSocket) {
    this.logger.debug(`Client disconnected: ${client.id}`);
  }

  // Clients join a room scoped to a specific location so they only
  // receive events for orders at that location.
  @SubscribeMessage("room:join")
  handleJoinRoom(
    @ConnectedSocket() client: TypedSocket,
    @MessageBody() locationId: string,
  ) {
    client.join(`location:${locationId}`);
    this.logger.debug(`${client.id} joined location:${locationId}`);
  }

  @SubscribeMessage("room:leave")
  handleLeaveRoom(
    @ConnectedSocket() client: TypedSocket,
    @MessageBody() locationId: string,
  ) {
    client.leave(`location:${locationId}`);
  }
}
