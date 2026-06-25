import { Injectable, Logger } from "@nestjs/common";

// Sends push notifications to the Order Hub Driver app via Expo's push service.
// The "new-job" category + "jobs" channel make the alert render Accept / Reject
// action buttons on the device, even when the app is closed.
@Injectable()
export class ExpoPushService {
  private readonly logger = new Logger(ExpoPushService.name);

  async sendNewJob(
    pushToken: string | null | undefined,
    opts: { orderId: string; title: string; body: string },
  ): Promise<void> {
    if (!pushToken) return;
    try {
      const res = await fetch("https://exp.host/--/api/v2/push/send", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({
          to: pushToken,
          title: opts.title,
          body: opts.body,
          sound: "default",
          priority: "high",
          channelId: "jobs",
          categoryId: "new-job",
          data: { orderId: opts.orderId },
        }),
      });
      if (!res.ok) {
        this.logger.warn(`Expo push HTTP ${res.status} for order ${opts.orderId}`);
      }
    } catch (err) {
      this.logger.warn(`Expo push failed for order ${opts.orderId}: ${(err as Error).message}`);
    }
  }
}
