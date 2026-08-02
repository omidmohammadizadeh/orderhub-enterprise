import {
  Injectable,
  Logger,
  NotFoundException,
} from "@nestjs/common";
import { PrismaService } from "../../infrastructure/database/prisma.service";
import { NotificationChannel, NotificationType, DevicePlatform } from "@orderhub/database";
import {
  defaultSmsFrom,
  isSmsConfigured,
  sendSmsViaProvider,
  smsConfigHint,
  smsProvider,
} from "../sms/sms-provider";

// ── DTOs ──────────────────────────────────────────────────────────────────────

export interface SendNotificationDto {
  userId?: string;
  type: NotificationType;
  title: string;
  body: string;
  data?: Record<string, unknown>;
  channels: NotificationChannel[];
}

export interface RegisterDeviceTokenDto {
  token: string;
  platform: DevicePlatform;
  deviceId?: string;
  appId?: string;
}

// ── Service ───────────────────────────────────────────────────────────────────

@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);

  constructor(private readonly prisma: PrismaService) {}

  // ── Channel router ─────────────────────────────────────────────────────────

  async send(tenantId: string, dto: SendNotificationDto): Promise<void> {
    const { userId, type, title, body, data = {}, channels } = dto;

    for (const channel of channels) {
      try {
        switch (channel) {
          case NotificationChannel.FCM: {
            if (!userId) break;
            const tokens = await this.prisma.deviceToken.findMany({
              where: { userId, tenantId, isActive: true, platform: DevicePlatform.ANDROID },
            });
            for (const t of tokens) {
              await this.sendFcm(t.token, title, body, data);
              await this.writeLog(tenantId, userId, type, channel, title, body, data, "SENT");
            }
            break;
          }

          case NotificationChannel.APNS: {
            if (!userId) break;
            const tokens = await this.prisma.deviceToken.findMany({
              where: { userId, tenantId, isActive: true, platform: DevicePlatform.IOS },
            });
            for (const t of tokens) {
              await this.sendApns(t.token, title, body, data);
              await this.writeLog(tenantId, userId, type, channel, title, body, data, "SENT");
            }
            break;
          }

          case NotificationChannel.WEB_PUSH: {
            if (!userId) break;
            const webTokens = await this.prisma.deviceToken.findMany({
              where: { userId, tenantId, isActive: true, platform: DevicePlatform.WEB },
            });
            for (const t of webTokens) {
              // Web push subscriptions store endpoint|p256dh|auth in the token field
              // separated by pipe character, or as JSON
              let endpoint = t.token;
              let p256dh = "";
              let auth = "";
              try {
                const parsed = JSON.parse(t.token) as {
                  endpoint: string;
                  p256dh: string;
                  auth: string;
                };
                endpoint = parsed.endpoint;
                p256dh = parsed.p256dh;
                auth = parsed.auth;
              } catch {
                // treat entire token as endpoint if not JSON
              }
              await this.sendWebPush(endpoint, p256dh, auth, title, body, data);
              await this.writeLog(tenantId, userId, type, channel, title, body, data, "SENT");
            }
            break;
          }

          case NotificationChannel.SMS: {
            if (!userId) break;
            // User model does not have a phone field directly; SMS requires
            // phone to be passed via data or a linked Customer record.
            // If data.phone is present, use that; otherwise skip.
            const phone = data.phone as string | undefined;
            if (phone) {
              const message = `${title}: ${body}`;
              await this.sendSms(phone, message);
              await this.writeLog(tenantId, userId, type, channel, title, body, data, "SENT");
            } else {
              this.logger.warn(
                `SMS channel requested but no phone in data for userId ${userId} — skipping`,
              );
            }
            break;
          }

          case NotificationChannel.EMAIL: {
            if (!userId) break;
            const user = await this.prisma.user.findUnique({
              where: { id: userId },
              select: { email: true, firstName: true, lastName: true },
            });
            if (user?.email) {
              const html = `<h2>${title}</h2><p>${body}</p>`;
              await this.sendEmail(user.email, title, html);
              await this.writeLog(tenantId, userId, type, channel, title, body, data, "SENT");
            }
            break;
          }

          case NotificationChannel.IN_APP: {
            // IN_APP notifications are written to NotificationLog and polled by the client
            await this.writeLog(tenantId, userId ?? null, type, channel, title, body, data, "SENT");
            break;
          }

          default:
            this.logger.warn(`Unknown notification channel: ${channel}`);
        }
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        this.logger.error(`Failed to send via ${channel}: ${errorMsg}`);
        await this.writeLog(
          tenantId,
          userId ?? null,
          type,
          channel,
          title,
          body,
          data,
          "FAILED",
          errorMsg,
        );
      }
    }
  }

  // ── Channel implementations (private) ──────────────────────────────────────

  private async sendFcm(
    token: string,
    title: string,
    body: string,
    data: Record<string, unknown>,
  ): Promise<void> {
    const fcmKey = process.env.FCM_SERVER_KEY;
    if (!fcmKey) {
      this.logger.warn("FCM_SERVER_KEY not set — skipping FCM notification");
      return;
    }

    try {
      const response = await fetch("https://fcm.googleapis.com/fcm/send", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `key=${fcmKey}`,
        },
        body: JSON.stringify({
          to: token,
          notification: { title, body },
          data: Object.fromEntries(
            Object.entries(data).map(([k, v]) => [k, String(v)]),
          ),
        }),
      });

      if (!response.ok) {
        const text = await response.text();
        throw new Error(`FCM HTTP ${response.status}: ${text}`);
      }

      const result = (await response.json()) as { success?: number; failure?: number };
      if (result.failure && result.failure > 0) {
        this.logger.warn(`FCM delivery failure for token ${token.slice(0, 20)}...`);
      }
    } catch (err) {
      this.logger.error(`FCM send error: ${err instanceof Error ? err.message : String(err)}`);
      throw err;
    }
  }

  private async sendApns(
    token: string,
    title: string,
    body: string,
    _data: Record<string, unknown>,
  ): Promise<void> {
    const apnsKeyId = process.env.APNS_KEY_ID;
    if (!apnsKeyId) {
      this.logger.warn("APNS_KEY_ID not set — skipping APNs notification");
      return;
    }

    // Full APNs implementation requires JWT signing with the APNS private key.
    // To complete: load APNS_AUTH_KEY (p8 file contents), APNS_TEAM_ID, APNS_BUNDLE_ID
    // from env. Sign a JWT with ES256 algorithm using the p8 key, then call
    // https://api.push.apple.com/3/device/<token> (or sandbox endpoint) with
    // Authorization: bearer <jwt> and apns-topic: <APNS_BUNDLE_ID> headers.
    // The signed JWT is valid for up to 1 hour and should be cached.
    this.logger.warn(
      `APNs: Apple JWT signing not yet implemented — token ${token.slice(0, 20)}... skipped`,
    );
  }

  private async sendWebPush(
    endpoint: string,
    p256dh: string,
    auth: string,
    title: string,
    body: string,
    data: Record<string, unknown>,
  ): Promise<void> {
    const vapidPublicKey = process.env.VAPID_PUBLIC_KEY;
    const vapidPrivateKey = process.env.VAPID_PRIVATE_KEY;

    if (!vapidPublicKey || !vapidPrivateKey) {
      this.logger.warn("VAPID_PUBLIC_KEY/VAPID_PRIVATE_KEY not set — skipping Web Push");
      return;
    }

    if (!endpoint) {
      this.logger.warn("Web Push: no endpoint provided — skipping");
      return;
    }

    try {
      // Attempt to use web-push library if available
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const webpush = require("web-push") as {
        setVapidDetails: (subject: string, publicKey: string, privateKey: string) => void;
        sendNotification: (
          subscription: { endpoint: string; keys: { p256dh: string; auth: string } },
          payload: string,
        ) => Promise<unknown>;
      };

      webpush.setVapidDetails(
        `mailto:${process.env.VAPID_SUBJECT ?? "admin@orderhub.io"}`,
        vapidPublicKey,
        vapidPrivateKey,
      );

      await webpush.sendNotification(
        { endpoint, keys: { p256dh, auth } },
        JSON.stringify({ title, body, data }),
      );
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "MODULE_NOT_FOUND") {
        this.logger.warn("web-push package not installed — skipping Web Push");
        return;
      }
      throw err;
    }
  }

  private async sendSms(phone: string, message: string): Promise<void> {
    // System notifications (not billed to a tenant wallet) go out through the
    // same provider layer as customer-facing SMS, so SMS_PROVIDER switches
    // both at once — otherwise a provider swap silently leaves half the
    // traffic on the old vendor's invoice.
    if (!isSmsConfigured()) {
      this.logger.warn(
        `${smsProvider()} not configured (${smsConfigHint()}) — skipping SMS`,
      );
      return;
    }
    await sendSmsViaProvider({
      to: phone,
      from: defaultSmsFrom(),
      body: message,
    });
  }

  private async sendEmail(to: string, subject: string, html: string): Promise<void> {
    const provider = process.env.EMAIL_PROVIDER ?? "SENDGRID";

    if (provider === "SENDGRID") {
      const apiKey = process.env.SENDGRID_API_KEY;
      const fromEmail = process.env.SENDGRID_FROM_EMAIL ?? "noreply@orderhub.io";

      if (!apiKey) {
        this.logger.warn("SENDGRID_API_KEY not set — skipping email");
        return;
      }

      const response = await fetch("https://api.sendgrid.com/v3/mail/send", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          personalizations: [{ to: [{ email: to }] }],
          from: { email: fromEmail },
          subject,
          content: [{ type: "text/html", value: html }],
        }),
      });

      if (!response.ok) {
        const text = await response.text();
        throw new Error(`SendGrid HTTP ${response.status}: ${text}`);
      }
    } else if (provider === "SES") {
      // AWS SES skeleton — requires AWS SDK setup with SES_REGION, AWS_ACCESS_KEY_ID,
      // AWS_SECRET_ACCESS_KEY, SES_FROM_EMAIL set in environment.
      // Install @aws-sdk/client-ses and use SendEmailCommand when ready.
      this.logger.warn("AWS SES email provider skeleton — not yet implemented");
    } else {
      this.logger.warn(`Unknown EMAIL_PROVIDER "${provider}" — skipping email`);
    }
  }

  // ── Public methods ─────────────────────────────────────────────────────────

  async registerDeviceToken(
    userId: string,
    tenantId: string,
    dto: RegisterDeviceTokenDto,
  ) {
    return this.prisma.deviceToken.upsert({
      where: { token: dto.token },
      create: {
        userId,
        tenantId,
        token: dto.token,
        platform: dto.platform,
        deviceId: dto.deviceId ?? null,
        appId: dto.appId ?? null,
        isActive: true,
      },
      update: {
        userId,
        tenantId,
        platform: dto.platform,
        deviceId: dto.deviceId ?? null,
        appId: dto.appId ?? null,
        isActive: true,
      },
    });
  }

  async unregisterDeviceToken(userId: string, token: string) {
    const existing = await this.prisma.deviceToken.findFirst({
      where: { token, userId },
    });
    if (!existing) throw new NotFoundException("Device token not found");

    return this.prisma.deviceToken.update({
      where: { token },
      data: { isActive: false },
    });
  }

  async getUserTokens(userId: string) {
    return this.prisma.deviceToken.findMany({
      where: { userId, isActive: true },
      orderBy: { createdAt: "desc" },
    });
  }

  async notifyLocation(
    locationId: string,
    tenantId: string,
    type: NotificationType,
    title: string,
    body: string,
    data?: Record<string, unknown>,
  ): Promise<void> {
    // Find location to get brandId then get all users for this tenant
    const location = await this.prisma.location.findFirst({
      where: { id: locationId, deletedAt: null },
      include: { brand: { select: { tenantId: true } } },
    });

    if (!location) {
      this.logger.warn(`notifyLocation: location ${locationId} not found`);
      return;
    }

    // Find users who belong to this tenant (staff members active at this location)
    const users = await this.prisma.user.findMany({
      where: {
        tenantId,
        isActive: true,
        deviceTokens: { some: { tenantId, isActive: true } },
      } as any,
      select: { id: true },
    });

    for (const user of users) {
      await this.send(tenantId, {
        userId: user.id,
        type,
        title,
        body,
        data,
        channels: [
          NotificationChannel.FCM,
          NotificationChannel.APNS,
          NotificationChannel.IN_APP,
        ],
      });
    }
  }

  async notifyNewOrder(order: {
    locationId: string;
    tenantId: string;
    displayId: string;
    platform: string;
  }): Promise<void> {
    const title = "New Order";
    const body = `Order #${order.displayId} received via ${order.platform}`;
    await this.notifyLocation(
      order.locationId,
      order.tenantId,
      NotificationType.ORDER_NEW,
      title,
      body,
      { orderId: order.displayId, platform: order.platform },
    );
  }

  async getNotificationHistory(
    tenantId: string,
    opts: { userId?: string; limit?: number; offset?: number },
  ) {
    const { userId, limit = 50, offset = 0 } = opts;

    const where: Record<string, unknown> = { tenantId };
    if (userId) where.userId = userId;

    const [data, total] = await this.prisma.$transaction([
      this.prisma.notificationLog.findMany({
        where,
        orderBy: { createdAt: "desc" },
        take: limit,
        skip: offset,
      }),
      this.prisma.notificationLog.count({ where }),
    ]);

    return { data, total, limit, offset };
  }

  // ── Private helpers ─────────────────────────────────────────────────────────

  private async writeLog(
    tenantId: string,
    userId: string | null | undefined,
    type: NotificationType,
    channel: NotificationChannel,
    title: string,
    body: string,
    data: Record<string, unknown>,
    status: string,
    errorMsg?: string,
  ) {
    try {
      await this.prisma.notificationLog.create({
        data: {
          tenantId,
          userId: userId ?? null,
          type,
          channel,
          title,
          body,
          data: data as any,
          status,
          errorMsg: errorMsg ?? null,
        },
      });
    } catch (err) {
      this.logger.error(
        `Failed to write notification log: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}
