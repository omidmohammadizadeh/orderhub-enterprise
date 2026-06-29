import {
  Injectable,
  OnModuleInit,
  OnModuleDestroy,
  Logger,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import Redis from "ioredis";
import {
  WORKER_EVENTS_CHANNEL,
  type WorkerEvent,
} from "@orderhub/shared";
import { SocketService } from "./socket.service";

// Subscribes to the Redis channel where the worker publishes events, then
// relays them to the correct Socket.IO room via SocketService. This gives us
// a clean worker → API → browser bridge without coupling the worker to the
// HTTP API or its socket server directly.
@Injectable()
export class RedisSubscriberService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RedisSubscriberService.name);
  private redis!: Redis;

  constructor(
    private readonly config: ConfigService,
    private readonly socket: SocketService,
  ) {}

  onModuleInit() {
    const url = (this.config.get<string>("QUEUE_REDIS_URL") ?? "redis://localhost:6379")
      .trim()
      .replace(/^['"]|['"]$/g, "");
    // maxRetriesPerRequest:null + enableReadyCheck:false — survive Upstash
    // dropping idle connections without "max retries per request" errors.
    this.redis = new Redis(url, {
      lazyConnect: false,
      maxRetriesPerRequest: null,
      enableReadyCheck: false,
    });

    this.redis.subscribe(WORKER_EVENTS_CHANNEL, (err, count) => {
      if (err) {
        this.logger.error(`Redis subscribe error: ${err.message}`);
        return;
      }
      this.logger.log(`Redis subscriber ready — listening on ${WORKER_EVENTS_CHANNEL}`);
    });

    this.redis.on("message", (_channel: string, message: string) => {
      this.handleMessage(message);
    });

    this.redis.on("error", (err: Error) =>
      this.logger.error(`Redis subscriber error: ${err.message}`),
    );
  }

  private handleMessage(raw: string) {
    let event: WorkerEvent;
    try {
      event = JSON.parse(raw) as WorkerEvent;
    } catch {
      this.logger.warn("Received malformed message on worker-events channel");
      return;
    }

    const { type, locationId, payload } = event;

    try {
      switch (type) {
        case "order:new":
          this.socket.emitToLocation(locationId, "order:new", payload as any);
          break;
        case "order:updated":
          this.socket.emitToLocation(locationId, "order:updated", payload as any);
          break;
        case "order:cancelled":
          this.socket.emitToLocation(locationId, "order:cancelled", payload as any);
          break;
        case "print:job":
          this.socket.emitToLocation(locationId, "print:job", payload as any);
          break;
        case "integration:status":
          this.socket.emitToLocation(locationId, "integration:status", payload as any);
          break;
        case "kds:order:new":
          this.socket.emitToLocation(locationId, "kds:order:new", payload as any);
          break;
        case "kds:ticket:bumped":
          this.socket.emitToLocation(locationId, "kds:ticket:bumped", payload as any);
          break;
        default:
          this.logger.warn(`Unknown worker event type: ${type}`);
      }
    } catch (err) {
      this.logger.error(`Failed to relay worker event ${type}: ${err}`);
    }
  }

  onModuleDestroy() {
    this.redis.disconnect();
  }
}
