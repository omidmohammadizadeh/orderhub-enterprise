import { Injectable, Logger } from "@nestjs/common";

// Sends push notifications to the Order Hub Driver app via Expo's push service.
// Android delivery requires FCM credentials (eas credentials) + google-services.json.
@Injectable()
export class ExpoPushService {
  private readonly logger = new Logger(ExpoPushService.name);

  /** New-job alert with Accept/Reject actions + the new-order chime. */
  async sendNewJob(
    pushToken: string | null | undefined,
    opts: { orderId: string; title: string; body: string },
  ): Promise<void> {
    await this.post(
      pushToken,
      {
        title: opts.title,
        body: opts.body,
        // iOS plays this bundled sound; Android plays the channel's sound.
        sound: "new_order.wav",
        channelId: "jobs-v2",
        categoryId: "new-job",
        data: { orderId: opts.orderId },
      },
      `order ${opts.orderId}`,
    );
  }

  /** Chat message alert (operator → driver, or customer → driver). */
  async sendMessage(
    pushToken: string | null | undefined,
    opts: { title: string; body: string; data?: Record<string, unknown> },
  ): Promise<void> {
    await this.post(
      pushToken,
      {
        title: opts.title,
        body: opts.body,
        sound: "default",
        channelId: "messages",
        data: { type: "chat", ...(opts.data ?? {}) },
      },
      "chat message",
    );
  }

  private async post(
    pushToken: string | null | undefined,
    payload: Record<string, unknown>,
    label: string,
  ): Promise<void> {
    if (!pushToken) {
      // Silent until now, which is why "it works on my phone but not theirs"
      // had nothing behind it in the log. No token means one of two things:
      // the driver declined the iOS notification prompt (it is asked once and
      // never again), or the phone registered against a DIFFERENT driver row
      // than the one dispatch just assigned. Both look identical from the
      // operator's side — the assign succeeds and the phone stays quiet.
      this.logger.warn(
        `No push token for ${label} — the driver's phone will not be told. ` +
          `Either notifications are denied on the device, or the token is on another driver record.`,
      );
      return;
    }
    try {
      const res = await fetch("https://exp.host/--/api/v2/push/send", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ to: pushToken, priority: "high", ...payload }),
      });
      if (!res.ok) {
        this.logger.warn(`Expo push HTTP ${res.status} for ${label}`);
        return;
      }
      // Expo returns HTTP 200 even when the ticket errored (e.g. Android FCM not
      // configured → "MismatchSenderId", or "DeviceNotRegistered").
      const json = (await res.json().catch(() => null)) as
        | { data?: { status?: string; message?: string; details?: { error?: string } } }
        | null;
      const ticket = json?.data;
      if (ticket?.status === "error") {
        this.logger.error(
          `Expo push ticket error for ${label}: ${ticket.message ?? "unknown"}` +
            (ticket.details?.error ? ` [${ticket.details.error}]` : ""),
        );
      } else {
        this.logger.log(`Expo push queued for ${label} (ticket ${ticket?.status ?? "?"})`);
      }
    } catch (err) {
      this.logger.warn(`Expo push failed for ${label}: ${(err as Error).message}`);
    }
  }
}
