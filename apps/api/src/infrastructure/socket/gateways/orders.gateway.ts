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
import { JwtService } from "@nestjs/jwt";
import { PrismaService } from "../../database/prisma.service";
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

  constructor(
    private readonly socketService: SocketService,
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
  ) {}

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

  // Clients join a room scoped to a specific location.
  // Tenant isolation: verify the JWT tenantId owns the requested locationId.
  @SubscribeMessage("room:join")
  async handleJoinRoom(
    @ConnectedSocket() client: TypedSocket,
    @MessageBody() locationId: string,
  ) {
    const tenantId = await this.extractTenantId(client);
    if (!tenantId) {
      this.logger.warn(`${client.id} room:join rejected — no valid JWT`);
      client.disconnect();
      return;
    }

    const location = await this.prisma.location.findFirst({
      where: { id: locationId, brand: { tenantId } },
      select: { id: true },
    });

    if (!location) {
      this.logger.warn(
        `${client.id} room:join denied — location ${locationId} not in tenant ${tenantId}`,
      );
      return; // silently deny, don't disconnect (could be stale location reference)
    }

    client.join(`location:${locationId}`);
    this.logger.debug(`${client.id} (tenant:${tenantId}) joined location:${locationId}`);
  }

  private async extractTenantId(client: TypedSocket): Promise<string | null> {
    try {
      const token =
        (client.handshake.auth?.token as string | undefined) ??
        (client.handshake.headers?.authorization?.replace("Bearer ", "") ?? "");
      if (!token) return null;
      const payload = this.jwt.verify<{ tenantId: string }>(token);
      return payload.tenantId ?? null;
    } catch {
      return null;
    }
  }

  @SubscribeMessage("room:leave")
  handleLeaveRoom(
    @ConnectedSocket() client: TypedSocket,
    @MessageBody() locationId: string,
  ) {
    client.leave(`location:${locationId}`);
  }
}
