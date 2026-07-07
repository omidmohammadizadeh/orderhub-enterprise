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

  // Clients join a room scoped to a specific location. Real-time order
  // pushes go to `location:<id>` rooms, so joining IS the read grant —
  // it must enforce the SAME per-user scoping as the REST orders endpoints
  // (tenant isolation alone would let a scoped user subscribe to a sibling
  // location's live orders). Admins may join any location in their tenant;
  // everyone else only locations they're assigned to (UserLocation, or a
  // location one of their UserBrand brands operates at).
  @SubscribeMessage("room:join")
  async handleJoinRoom(
    @ConnectedSocket() client: TypedSocket,
    @MessageBody() locationId: string,
  ) {
    const auth = await this.extractAuth(client);
    if (!auth) {
      this.logger.warn(`${client.id} room:join rejected — no valid JWT`);
      client.disconnect();
      return;
    }
    const { tenantId, userId, role } = auth;

    const location = await this.prisma.location.findFirst({
      where: { id: locationId, brand: { tenantId } },
      select: { id: true },
    });
    if (!location) {
      this.logger.warn(
        `${client.id} room:join denied — location ${locationId} not in tenant ${tenantId}`,
      );
      return; // silently deny, don't disconnect (could be a stale reference)
    }

    if (!(await this.userCanAccessLocation(userId, role, locationId))) {
      this.logger.warn(
        `${client.id} room:join denied — user ${userId} not assigned to location ${locationId}`,
      );
      return;
    }

    client.join(`location:${locationId}`);
    this.logger.debug(`${client.id} (tenant:${tenantId}) joined location:${locationId}`);
  }

  // Mirror OrdersService's ORDER_ADMIN_ROLES: these see every location in
  // the tenant; everyone else is constrained to their assignments.
  private async userCanAccessLocation(
    userId: string,
    role: string,
    locationId: string,
  ): Promise<boolean> {
    if (["PLATFORM_ADMIN", "TENANT_OWNER", "OWNER"].includes(role)) return true;
    const byLocation = await (this.prisma as any).userLocation.count({
      where: { userId, locationId },
    });
    if (byLocation > 0) return true;
    const byBrand = await (this.prisma as any).userBrand.count({
      where: {
        userId,
        brand: {
          OR: [
            { primaryLocationId: locationId },
            { locations: { some: { id: locationId } } },
          ],
        },
      },
    });
    return byBrand > 0;
  }

  private async extractAuth(
    client: TypedSocket,
  ): Promise<{ tenantId: string; userId: string; role: string } | null> {
    try {
      const token =
        (client.handshake.auth?.token as string | undefined) ??
        (client.handshake.headers?.authorization?.replace("Bearer ", "") ?? "");
      if (!token) return null;
      const payload = this.jwt.verify<{
        sub: string;
        tenantId: string;
        role: string;
      }>(token);
      if (!payload?.tenantId || !payload?.sub) return null;
      return {
        tenantId: payload.tenantId,
        userId: payload.sub,
        role: String(payload.role ?? ""),
      };
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
