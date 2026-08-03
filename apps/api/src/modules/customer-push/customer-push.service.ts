import { Injectable, Logger, NotFoundException } from "@nestjs/common";
import webpush from "web-push";
import { PrismaService } from "../../infrastructure/database/prisma.service";

// Telling a customer their food is ready, without an app store.
//
// Web Push is the whole point of the PWA route: a browser that has been added
// to the home screen can be woken by the server exactly like a native app, on
// Android since forever and on iOS since 16.4. No review queue, no $99, no
// per-restaurant binary.
//
// The credential is the endpoint. A push endpoint is issued by the browser's
// own push service (FCM for Chrome, Mozilla autopush, Apple's) and is
// unguessable, which is what lets this work for guests who never sign in —
// and guests are most of the audience, because nobody creates an account to
// find out where their curry is.
//
// Nothing in here may ever throw into an order status change. A restaurant
// marking an order READY must not fail because Apple's push service had a bad
// minute, so every send path swallows its errors and says so in the log.

/** Statuses worth interrupting someone's evening for, and what to say. */
const MESSAGES: Record<string, { title: string; body: string }> = {
  ACCEPTED: {
    title: "Order confirmed",
    body: "The restaurant has accepted your order.",
  },
  PREPARING: {
    title: "Your food is being made",
    body: "The kitchen has started on your order.",
  },
  READY: {
    title: "Ready for collection",
    body: "Your order is ready to pick up.",
  },
  OUT_FOR_DELIVERY: {
    title: "On its way",
    body: "Your driver is heading to you now.",
  },
  RIDER_ARRIVED: {
    title: "Your driver has arrived",
    body: "They're outside with your order.",
  },
  COMPLETED: {
    title: "Delivered",
    body: "Enjoy your food. Thanks for ordering!",
  },
  CANCELLED: {
    title: "Order cancelled",
    body: "Your order has been cancelled. Contact the restaurant if this is unexpected.",
  },
};

/** READY means different things depending on how the food is leaving. */
const DELIVERY_READY = {
  title: "Ready — waiting for a driver",
  body: "Your order is made and waiting to be collected by a driver.",
};

@Injectable()
export class CustomerPushService {
  private readonly logger = new Logger(CustomerPushService.name);
  private vapidReady = false;

  constructor(private readonly prisma: PrismaService) {}

  private db(): any {
    return this.prisma as any;
  }

  /** The key the browser needs before it can subscribe. Public by design. */
  publicKey(): string | null {
    return process.env.VAPID_PUBLIC_KEY || null;
  }

  configured(): boolean {
    return !!(process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY);
  }

  /** Lazy because the keys come from env and we don't want a boot-time throw
   *  on an install that hasn't set them up yet. */
  private ensureVapid(): boolean {
    if (this.vapidReady) return true;
    const pub = process.env.VAPID_PUBLIC_KEY;
    const priv = process.env.VAPID_PRIVATE_KEY;
    if (!pub || !priv) return false;
    webpush.setVapidDetails(
      // Must be a mailto: or https: URL — push services reject anything else.
      process.env.VAPID_SUBJECT ?? "mailto:support@orderhubpos.com",
      pub,
      priv,
    );
    this.vapidReady = true;
    return true;
  }

  /**
   * Subscribe this browser to one order's updates.
   *
   * The tenant is read off the order, never taken from the caller — this route
   * is public, and a client-supplied tenantId on a public route is how you end
   * up writing rows into someone else's account.
   */
  async subscribe(args: {
    orderId: string;
    endpoint: string;
    p256dh: string;
    auth: string;
    deviceRef?: string | null;
    userAgent?: string | null;
  }): Promise<{ ok: true }> {
    const order = await this.db().order.findUnique({
      where: { id: args.orderId },
      select: {
        id: true,
        tenantId: true,
        locationId: true,
        brandId: true,
        customerId: true,
      },
    });
    if (!order) throw new NotFoundException("Order not found");

    // Upsert on endpoint: a browser that re-subscribes (permission re-granted,
    // key rotated, app reinstalled) must update its row rather than add a
    // second one, or one order would buzz the same phone twice.
    const sub = await this.db().customerPushSubscription.upsert({
      where: { endpoint: args.endpoint },
      create: {
        tenantId: order.tenantId,
        locationId: order.locationId ?? null,
        brandId: order.brandId ?? null,
        endpoint: args.endpoint,
        p256dh: args.p256dh,
        auth: args.auth,
        customerId: order.customerId ?? null,
        deviceRef: args.deviceRef ?? null,
        userAgent: args.userAgent?.slice(0, 300) ?? null,
      },
      update: {
        p256dh: args.p256dh,
        auth: args.auth,
        isActive: true,
        revokedAt: null,
        // A subscription that comes back after a revoke is a fresh consent —
        // re-adopt it into whatever tenant the current order belongs to.
        tenantId: order.tenantId,
        locationId: order.locationId ?? null,
        brandId: order.brandId ?? null,
        ...(order.customerId ? { customerId: order.customerId } : {}),
      },
    });

    await this.db().customerPushOrder.upsert({
      where: {
        subscriptionId_orderId: { subscriptionId: sub.id, orderId: order.id },
      },
      create: { subscriptionId: sub.id, orderId: order.id },
      update: {},
    });

    return { ok: true };
  }

  /** Turn it off for this browser. Idempotent — unsubscribing twice is fine. */
  async unsubscribe(endpoint: string): Promise<{ ok: true }> {
    await this.db().customerPushSubscription.updateMany({
      where: { endpoint },
      data: { isActive: false, revokedAt: new Date() },
    });
    return { ok: true };
  }

  /**
   * An order moved. Tell whoever asked to be told.
   *
   * Errors are swallowed on purpose: this is called from the order status
   * transaction's aftermath, and a restaurant must never see "couldn't mark
   * ready" because a push service was down.
   */
  async notifyOrderStatus(args: {
    orderId: string;
    status: string;
    orderNumber?: number | null;
    displayId?: string | null;
    fulfillmentType?: string | null;
    storefrontSlug?: string | null;
  }): Promise<void> {
    try {
      let message = MESSAGES[args.status];
      if (args.status === "READY" && args.fulfillmentType === "DELIVERY") {
        message = DELIVERY_READY;
      }
      // Every other status is internal bookkeeping. Buzzing someone's phone
      // for PENDING_DISPATCH would teach them to turn notifications off.
      if (!message) return;

      if (!this.ensureVapid()) {
        this.logger.warn("VAPID keys not set — customer push skipped");
        return;
      }

      const links = await this.db().customerPushOrder.findMany({
        where: { orderId: args.orderId, subscription: { isActive: true } },
        include: { subscription: true },
      });
      // Say so out loud. Silence on the happy path meant a clean log was
      // indistinguishable from "nobody was subscribed", and the only way to
      // tell them apart was to go and look at a phone.
      if (links.length === 0) {
        this.logger.log(
          `customer push ${args.status} order=${args.orderId} — no subscribers`,
        );
        return;
      }

      const ref = args.displayId ?? (args.orderNumber ? `#${args.orderNumber}` : null);
      const payload = this.buildPayload({
        title: ref ? `${message.title} · ${ref}` : message.title,
        body: message.body,
        // The restaurant's logo on the lock screen, not ours. One extra read
        // per status change, on a path that's already fire-and-forget.
        icon: await this.logoFor(links[0]?.subscription),
        // Collapse on the order, so three quick transitions leave one
        // notification in the shade rather than a stack of stale ones.
        tag: `order-${args.orderId}`,
        data: {
          orderId: args.orderId,
          status: args.status,
          url: args.storefrontSlug
            ? `/order/${args.storefrontSlug}/status/${args.orderId}`
            : `/order/status/${args.orderId}`,
        },
      });

      const results = await Promise.all(
        links.map((link: any) => this.deliver(link.subscription, payload)),
      );
      const sent = results.filter(Boolean).length;
      this.logger.log(
        `customer push ${args.status} order=${args.orderId} delivered=${sent}/${links.length}`,
      );
    } catch (e: any) {
      this.logger.error(`customer push for ${args.orderId} failed: ${e?.message ?? e}`);
    }
  }

  /**
   * Serialise the notification, guaranteeing it fits.
   *
   * Push services cap the ENCRYPTED payload at 4096 bytes and FCM refuses the
   * whole send with a 400 when you go over — no partial delivery, no warning,
   * the customer just never hears anything. The text is ~250 bytes; the only
   * thing that can blow the budget is the icon, because logoUrl is sometimes a
   * base64 data URL (the Supabase uploader falls back to storing the data URL
   * inline when it isn't configured, and a logo is easily several KB).
   *
   * So the icon is dropped rather than the notification. A generic mark beats
   * silence.
   */
  private buildPayload(input: Record<string, unknown>): string {
    const full = JSON.stringify(input);
    // Encryption adds padding and a header on top of the plaintext, so aim
    // well under 4096 rather than at it.
    if (Buffer.byteLength(full, "utf8") <= 3000) return full;

    const { icon: _dropped, ...lean } = input;
    const trimmed = JSON.stringify(lean);
    this.logger.warn(
      `push payload ${Buffer.byteLength(full, "utf8")}B — dropped icon, now ${Buffer.byteLength(trimmed, "utf8")}B`,
    );
    return trimmed;
  }

  /**
   * The logo to show on the notification: the brand's if the order came
   * through a brand storefront, otherwise the location's. Null falls back to
   * the OrderHub mark in the service worker.
   *
   * Only http(s) URLs qualify. A data: URL would be inlined into every push
   * and is the one field big enough to breach the 4KB ceiling — and the
   * service worker can fetch a remote icon perfectly well, so there is nothing
   * to gain by embedding one.
   */
  private usableIcon(url?: string | null): string | null {
    if (!url) return null;
    if (!/^https?:\/\//i.test(url)) return null;
    // A URL this long is a signed blob or a tracking monster, not a logo.
    return url.length <= 500 ? url : null;
  }

  private async logoFor(sub: any): Promise<string | null> {
    if (!sub) return null;
    try {
      if (sub.brandId) {
        const brand = await this.db().brand.findUnique({
          where: { id: sub.brandId },
          select: { logoUrl: true },
        });
        const usable = this.usableIcon(brand?.logoUrl);
        // Fall through to the location logo when the brand's is a data URL —
        // it may well have a usable one.
        if (usable) return usable;
      }
      if (sub.locationId) {
        const loc = await this.db().location.findUnique({
          where: { id: sub.locationId },
          select: { logoUrl: true },
        });
        return this.usableIcon(loc?.logoUrl);
      }
      return null;
    } catch {
      return null;
    }
  }

  /** One send, with the dead-endpoint cleanup that keeps the table honest.
   *  Returns whether the push service accepted it. */
  private async deliver(sub: any, payload: string): Promise<boolean> {
    try {
      await webpush.sendNotification(
        {
          endpoint: sub.endpoint,
          keys: { p256dh: sub.p256dh, auth: sub.auth },
        },
        payload,
      );
      await this.db().customerPushSubscription.update({
        where: { id: sub.id },
        data: { lastSentAt: new Date() },
      });
      return true;
    } catch (e: any) {
      const status = e?.statusCode;
      // 404/410 are the push service telling us this browser is gone for good
      // — uninstalled, cleared, or permission revoked. Retrying forever is how
      // a push table becomes 90% garbage and every send takes a minute.
      if (status === 404 || status === 410) {
        await this.db()
          .customerPushSubscription.update({
            where: { id: sub.id },
            data: { isActive: false, revokedAt: new Date() },
          })
          .catch(() => undefined);
        return false;
      }
      // web-push puts the push service's actual complaint in `body` and the
      // generic "Received unexpected response code" in `message`. Logging only
      // the message tells you a send failed but never why, which is a bad
      // trade on a path this hard to reproduce.
      this.logger.warn(
        `push to ${String(sub.endpoint).slice(0, 60)}… failed${
          status ? ` (${status})` : ""
        }: ${e?.message ?? e}${e?.body ? ` — ${String(e.body).slice(0, 300)}` : ""}`,
      );
      return false;
    }
  }
}
