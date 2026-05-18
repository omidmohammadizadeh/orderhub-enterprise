import { Injectable, Logger, ForbiddenException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { InjectQueue } from "@nestjs/bull";
import type { Queue } from "bull";
import { QUEUES, ORDER_JOBS } from "@orderhub/shared";
import { PrismaService } from "../../infrastructure/database/prisma.service";

const PLATFORMS = ["UBER_EATS", "DELIVEROO", "JUST_EAT", "HUBRISE", "DIRECT", "POS"] as const;

const SAMPLE_ITEMS = [
  { name: "Classic Burger", price: 1299, category: "Mains" },
  { name: "Veggie Wrap", price: 999, category: "Mains" },
  { name: "Margherita Pizza", price: 1499, category: "Pizza" },
  { name: "Chicken Wings (6pc)", price: 899, category: "Starters" },
  { name: "Caesar Salad", price: 849, category: "Salads" },
  { name: "Fries", price: 349, category: "Sides" },
  { name: "Onion Rings", price: 399, category: "Sides" },
  { name: "Soft Drink", price: 249, category: "Drinks" },
  { name: "Milkshake", price: 549, category: "Drinks" },
  { name: "Cheesecake", price: 699, category: "Desserts" },
];

const NAMES = [
  "Alice Johnson", "Bob Smith", "Carol White", "Dave Brown", "Eve Davis",
  "Frank Wilson", "Grace Lee", "Hank Martin", "Iris Taylor", "Jack Anderson",
];

// Registry of simulated outages — platform → expiry timestamp
const outageRegistry = new Map<string, number>();

@Injectable()
export class SandboxService {
  private readonly logger = new Logger(SandboxService.name);
  private readonly isProduction: boolean;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    @InjectQueue(QUEUES.ORDER_PROCESSING) private readonly orderQueue: Queue,
  ) {
    this.isProduction = this.config.get<string>("NODE_ENV") === "production";
  }

  private guardNonProd() {
    if (this.isProduction) {
      throw new ForbiddenException("Sandbox tools are disabled in production");
    }
  }

  async generateOrders(
    tenantId: string,
    locationId: string,
    count: number,
    platform: string,
  ) {
    this.guardNonProd();

    const orders: Array<{ id: string }> = [];
    const created: string[] = [];

    for (let i = 0; i < count; i++) {
      const itemCount = Math.floor(Math.random() * 4) + 1;
      const selectedItems = SAMPLE_ITEMS.sort(() => Math.random() - 0.5).slice(0, itemCount);
      const subtotal = selectedItems.reduce((s, it) => s + it.price, 0);
      const tax = Math.round(subtotal * 0.1);
      const total = subtotal + tax;
      const customerName = NAMES[Math.floor(Math.random() * NAMES.length)];
      const externalId = `sandbox-${Date.now()}-${i}-${Math.random().toString(36).slice(2, 8)}`;

      const order = await this.prisma.order.create({
        data: {
          externalId,
          platform: platform as any,
          status: "PENDING",
          total,
          subtotal,
          tax,
          customerName,
          isSandbox: true,
          tenantId,
          locationId,
          items: {
            create: selectedItems.map((it) => ({
              name: it.name,
              quantity: 1,
              unitPrice: it.price,
              totalPrice: it.price,
            })),
          },
        } as any,
      });

      // Enqueue for processing
      await this.orderQueue.add(
        ORDER_JOBS.INGEST,
        { orderId: order.id, tenantId, locationId },
        { jobId: `ingest-${order.id}` },
      );

      created.push(order.id);
    }

    this.logger.log(`Sandbox: generated ${count} orders for tenant ${tenantId}`);
    return { success: true, message: `Created ${count} test orders`, data: { orderIds: created } };
  }

  async rushHourSimulation(
    tenantId: string,
    locationId: string,
    orderCount: number,
    durationMinutes: number,
  ) {
    this.guardNonProd();

    const intervalMs = (durationMinutes * 60_000) / orderCount;
    const platforms = PLATFORMS.filter((p) => p !== "POS");
    const created: string[] = [];

    for (let i = 0; i < orderCount; i++) {
      const platform = platforms[i % platforms.length];
      const delay = Math.round(intervalMs * i);

      const itemCount = Math.floor(Math.random() * 5) + 1;
      const selectedItems = SAMPLE_ITEMS.sort(() => Math.random() - 0.5).slice(0, itemCount);
      const subtotal = selectedItems.reduce((s, it) => s + it.price, 0);
      const tax = Math.round(subtotal * 0.1);
      const total = subtotal + tax;
      const externalId = `rush-${Date.now()}-${i}-${Math.random().toString(36).slice(2, 8)}`;

      const order = await this.prisma.order.create({
        data: {
          externalId,
          platform: platform as any,
          status: "PENDING",
          total,
          subtotal,
          tax,
          customerName: NAMES[i % NAMES.length],
          isSandbox: true,
          tenantId,
          locationId,
          items: {
            create: selectedItems.map((it) => ({
              name: it.name,
              quantity: 1,
              unitPrice: it.price,
              totalPrice: it.price,
            })),
          },
        } as any,
      });

      await this.orderQueue.add(
        ORDER_JOBS.INGEST,
        { orderId: order.id, tenantId, locationId },
        { jobId: `ingest-${order.id}`, delay },
      );

      created.push(order.id);
    }

    this.logger.log(`Sandbox: rush-hour simulation started — ${orderCount} orders over ${durationMinutes}m`);
    return {
      success: true,
      message: `Rush hour: ${orderCount} orders scheduled over ${durationMinutes} minutes`,
      data: { count: created.length },
    };
  }

  async replayWebhook(eventId: string) {
    this.guardNonProd();

    const event = await this.prisma.webhookEvent.findUnique({ where: { id: eventId } });
    if (!event) {
      return { success: false, message: `Webhook event ${eventId} not found` };
    }

    // Reset the event so it will be re-processed
    await this.prisma.webhookEvent.update({
      where: { id: eventId },
      data: { processedAt: null, processingError: null, orderId: null },
    });

    this.logger.log(`Sandbox: replaying webhook event ${eventId}`);
    return {
      success: true,
      message: `Webhook event ${event.externalEventId} queued for replay`,
      data: { platform: event.platform, externalEventId: event.externalEventId },
    };
  }

  async simulateOutage(platform: string, durationSeconds: number) {
    this.guardNonProd();

    const expiresAt = Date.now() + durationSeconds * 1000;
    outageRegistry.set(platform, expiresAt);

    this.logger.log(`Sandbox: simulating ${platform} outage for ${durationSeconds}s`);
    return {
      success: true,
      message: `${platform} outage simulated for ${durationSeconds} seconds`,
      data: { platform, expiresAt: new Date(expiresAt).toISOString() },
    };
  }

  // Check if a platform is simulating an outage — called by sync clients
  static isPlatformDown(platform: string): boolean {
    const expiry = outageRegistry.get(platform);
    if (!expiry) return false;
    if (Date.now() > expiry) {
      outageRegistry.delete(platform);
      return false;
    }
    return true;
  }

  async clearOrders(tenantId: string) {
    this.guardNonProd();

    const deleted = await (this.prisma as any).order.deleteMany({
      where: { tenantId, isSandbox: true },
    });

    this.logger.log(`Sandbox: cleared ${deleted.count} test orders for tenant ${tenantId}`);
    return {
      success: true,
      message: `Deleted ${deleted.count} sandbox orders`,
    };
  }
}
