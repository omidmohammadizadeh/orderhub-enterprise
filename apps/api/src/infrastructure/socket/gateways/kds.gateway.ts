import {
  WebSocketGateway,
  WebSocketServer,
  SubscribeMessage,
  MessageBody,
  ConnectedSocket,
  OnGatewayConnection,
  OnGatewayDisconnect,
} from "@nestjs/websockets";
import { Logger } from "@nestjs/common";
import { Server, Socket } from "socket.io";
import { JwtService } from "@nestjs/jwt";
import { PrismaService } from "../../database/prisma.service";
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
export class KdsGateway implements OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer()
  server!: Server;

  private readonly logger = new Logger(KdsGateway.name);

  constructor(
    private readonly jwt: JwtService,
    private readonly prisma: PrismaService,
  ) {}

  handleConnection(client: TypedSocket) {
    this.logger.debug(`KDS client connected: ${client.id}`);
  }

  handleDisconnect(client: TypedSocket) {
    this.logger.debug(`KDS client disconnected: ${client.id}`);
  }

  @SubscribeMessage("room:join")
  async handleJoin(
    @ConnectedSocket() client: TypedSocket,
    @MessageBody() locationId: string,
  ) {
    const tenantId = await this.extractTenantId(client);
    if (!tenantId) {
      // Deny WITHOUT disconnecting — same reasoning as OrdersGateway: the
      // handshake token expires after 15min, and kicking a stale-token
      // socket caused a connect→join→kick loop on KDS screens left open
      // overnight. An unjoined socket receives nothing, so denying is safe.
      this.logger.warn(`${client.id} kds room:join denied — no valid JWT (stale handshake?)`);
      return;
    }

    const location = await this.prisma.location.findFirst({
      where: { id: locationId, brand: { tenantId } },
      select: { id: true },
    });

    if (!location) {
      this.logger.warn(
        `${client.id} kds room:join denied — location ${locationId} not in tenant ${tenantId}`,
      );
      return;
    }

    client.join(`kds:${locationId}`);
    this.logger.debug(`KDS screen ${client.id} (tenant:${tenantId}) joined kds:${locationId}`);
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
