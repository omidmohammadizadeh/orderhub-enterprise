import { Injectable, OnModuleInit, OnModuleDestroy, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import Redis from "ioredis";
import {
  WORKER_EVENTS_CHANNEL,
  type WorkerEvent,
  type WorkerEventType,
} from "@orderhub/shared";

// Publishes typed events from the worker to a Redis pub/sub channel.
// The API's RedisSubscriberService listens and relays them to Socket.IO clients.
@Injectable()
export class EventPublisherService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(EventPublisherService.name);
  private redis!: Redis;

  constructor(private readonly config: ConfigService) {}

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
    this.redis.on("error", (err) =>
      this.logger.error(`Redis publisher error: ${err.message}`),
    );
  }

  async publish<T>(
    type: WorkerEventType,
    locationId: string,
    tenantId: string,
    payload: T,
  ): Promise<void> {
    const event: WorkerEvent<T> = {
      type,
      locationId,
      tenantId,
      payload,
      emittedAt: new Date().toISOString(),
    };
    try {
      await this.redis.publish(WORKER_EVENTS_CHANNEL, JSON.stringify(event));
    } catch (err) {
      // Non-fatal — log and continue; socket event will be missed but order state is correct
      this.logger.warn(`Failed to publish event ${type}: ${err}`);
    }
  }

  onModuleDestroy() {
    this.redis.disconnect();
  }
}
