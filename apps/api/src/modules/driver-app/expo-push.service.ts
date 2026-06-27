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
          // iOS plays this bundled sound; Android plays the channel's sound.
          // Keep channelId in sync with JOB_CHANNEL in the app.
          sound: "new_order.wav",
          priority: "high",
          channelId: "jobs-v2",
          categoryId: "new-job",
          data: { orderId: opts.orderId },
        }),
      });
      if (!res.ok) {
        this.logger.warn(`Expo push HTTP ${res.status} for order ${opts.orderId}`);
        return;
      }
      // Expo returns HTTP 200 even when the ticket itself errored (e.g. Android
      // FCM not configured → "MismatchSenderId", or "DeviceNotRegistered").
      // Surface that here so misconfigured push doesn't fail silently.
      const json = (await res.json().catch(() => null)) as
        | { data?: { status?: string; message?: string; details?: { error?: string } } }
        | null;
      const ticket = json?.data;
      if (ticket?.status === "error") {
        this.logger.error(
          `Expo push ticket error for order ${opts.orderId}: ${ticket.message ?? "unknown"}` +
            (ticket.details?.error ? ` [${ticket.details.error}]` : "") +
            ` — Android delivery needs FCM credentials (eas credentials) + google-services.json.`,
        );
      } else {
        this.logger.log(`Expo push queued for order ${opts.orderId} (ticket ${ticket?.status ?? "?"})`);
      }
    } catch (err) {
      this.logger.warn(`Expo push failed for order ${opts.orderId}: ${(err as Error).message}`);
    }
  }
}
