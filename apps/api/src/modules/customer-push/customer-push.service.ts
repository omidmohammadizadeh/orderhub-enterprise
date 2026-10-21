import { BadRequestException, Injectable, Logger, NotFoundException } from "@nestjs/common";
import webpush from "web-push";
import { PrismaService } from "../../infrastructure/database/prisma.service";
import {
  type AutomationRow,
  type LocationReviewRow,
  type PushTrigger,
  REVIEW_TRIGGER,
  effectiveReviewRow,
  fitSendWindow,
  isEnabled,
  isExpoToken,
  isPushTrigger,
  resolveMessage,
  reviewDelayMinutes,
} from "./push-messages";

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
//
// The same table also holds the restaurant's own app installs (kind EXPO): the
// endpoint is the ExponentPushToken and the send goes through Expo, which
// fronts APNs and FCM for every white-label build.

/**
 * A tap target has to be a same-origin relative path. This value comes off a
 * public endpoint, so anything else is discarded rather than sanitised —
 * "//evil.com" is a protocol-relative URL, not a path, hence the second check.
 * Returning null is safe: the service worker falls back to "/".
 */
function safePath(raw?: string | null): string | null {
  if (!raw) return null;
  if (!raw.startsWith("/") || raw.startsWith("//")) return null;
  return raw.length <= 300 ? raw : null;
}

const EXPO_SEND_URL = "https://exp.host/--/api/v2/push/send";
/** Expo accepts at most 100 messages per request. */
const EXPO_BATCH = 100;
/** Browser pushes go out this many at a time, so a campaign to 5,000 phones
 *  neither opens 5,000 sockets nor takes all night. */
const WEB_CONCURRENCY = 50;

/** One push, ready to go to any number of subscriptions. */
export type PushContent = {
  title: string;
  body: string;
  icon?: string | null;
  /** Collapse key: a later push with the same tag replaces the earlier one. */
  tag?: string;
  data?: Record<string, unknown>;
  /** Where a tap lands, per subscription — browsers on different storefronts
   *  need different paths. Omitted → the service worker opens "/". */
  urlFor?: (sub: any) => string | null;
};

/** How long after acceptance a newly subscribed device still gets the
 *  "accepted" push it missed (see subscribe()). */
const ACCEPTED_CATCH_UP_MS = 10 * 60_000;

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
   * Subscribe this browser — or this app install — to one order's updates.
   *
   * The tenant is read off the order, never taken from the caller — this route
   * is public, and a client-supplied tenantId on a public route is how you end
   * up writing rows into someone else's account.
   */
  async subscribe(args: {
    orderId: string;
    /** Browser: the push service endpoint. */
    endpoint?: string | null;
    p256dh?: string | null;
    auth?: string | null;
    /** Native app: the ExponentPushToken, instead of endpoint + keys. */
    expoToken?: string | null;
    platform?: string | null;
    appId?: string | null;
    /** Only ever turns offers ON here. Turning them off is preferences(). */
    marketingOptIn?: boolean;
    deviceRef?: string | null;
    userAgent?: string | null;
    /** Where tapping the notification should land, as the subscribing page
     *  knows it. Relative path only — see safePath. */
    trackPath?: string | null;
  }): Promise<{ ok: true }> {
    const device = this.deviceFrom(args);

    const order = await this.db().order.findUnique({
      where: { id: args.orderId },
      select: {
        id: true,
        tenantId: true,
        locationId: true,
        brandId: true,
        customerId: true,
        status: true,
        acceptedAt: true,
        orderNumber: true,
        displayId: true,
        fulfillmentType: true,
      },
    });
    if (!order) throw new NotFoundException("Order not found");

    // Upsert on endpoint: a browser that re-subscribes (permission re-granted,
    // key rotated, app reinstalled) must update its row rather than add a
    // second one, or one order would buzz the same phone twice.
    const sub = await this.db().customerPushSubscription.upsert({
      where: { endpoint: device.endpoint },
      create: {
        tenantId: order.tenantId,
        locationId: order.locationId ?? null,
        brandId: order.brandId ?? null,
        ...device,
        marketingOptIn: !!args.marketingOptIn,
        customerId: order.customerId ?? null,
        deviceRef: args.deviceRef ?? null,
        userAgent: args.userAgent?.slice(0, 300) ?? null,
      },
      update: {
        ...device,
        isActive: true,
        revokedAt: null,
        // A subscription that comes back after a revoke is a fresh consent —
        // re-adopt it into whatever tenant the current order belongs to.
        tenantId: order.tenantId,
        locationId: order.locationId ?? null,
        brandId: order.brandId ?? null,
        ...(args.marketingOptIn ? { marketingOptIn: true } : {}),
        ...(order.customerId ? { customerId: order.customerId } : {}),
      },
    });

    const trackPath = safePath(args.trackPath);
    const linkKey = { subscriptionId_orderId: { subscriptionId: sub.id, orderId: order.id } };
    const alreadyLinked = await this.db().customerPushOrder.findUnique({ where: linkKey, select: { orderId: true } });
    await this.db().customerPushOrder.upsert({
      where: {
        subscriptionId_orderId: { subscriptionId: sub.id, orderId: order.id },
      },
      create: { subscriptionId: sub.id, orderId: order.id, trackPath },
      // Don't overwrite a good path with a missing one — the storefront and
      // the tracking page both re-subscribe, and only one of them may know it.
      update: trackPath ? { trackPath } : {},
    });

    // Auto-accept moves the order to ACCEPTED inside checkout, a second
    // before the app (or page) can subscribe, so the "accepted" push went
    // out to nobody. A device that links itself to an order that is still
    // freshly ACCEPTED gets that push now — once, this device only. Older
    // acceptances stay quiet: opening yesterday's order shouldn't buzz.
    const acceptedMs = order.acceptedAt ? Date.now() - new Date(order.acceptedAt).getTime() : Infinity;
    if (!alreadyLinked && order.status === "ACCEPTED" && acceptedMs <= ACCEPTED_CATCH_UP_MS) {
      void this.notifyOrderStatus({
        orderId: order.id,
        status: "ACCEPTED",
        orderNumber: order.orderNumber,
        displayId: order.displayId,
        fulfillmentType: order.fulfillmentType,
        onlySubscriptionId: sub.id,
      }).catch(() => undefined);
    }

    return { ok: true };
  }

  /**
   * A restaurant's own app, registering on first launch — before there is any
   * order to hang it off.
   *
   * The tenant comes from the brand the app is built for. That id ships inside
   * the app, so anyone can read it and register a token against it; the worst
   * they get is that brand's offers on their own phone, which is what the app
   * is for anyway.
   */
  async registerDevice(args: {
    expoToken: string;
    brandId: string;
    locationId?: string | null;
    platform?: string | null;
    appId?: string | null;
    marketingOptIn?: boolean;
  }): Promise<{ ok: true }> {
    if (!isExpoToken(args.expoToken)) throw new BadRequestException("Not an Expo push token");
    const brand = await this.db().brand.findUnique({
      where: { id: args.brandId },
      select: { id: true, tenantId: true },
    });
    if (!brand) throw new NotFoundException("Brand not found");

    // A location from another tenant would put this phone in their audience.
    let locationId: string | null = null;
    if (args.locationId) {
      const loc = await this.db().location.findFirst({
        where: { id: args.locationId, brand: { tenantId: brand.tenantId } },
        select: { id: true },
      });
      locationId = loc?.id ?? null;
    }

    const device = this.deviceFrom({ expoToken: args.expoToken, platform: args.platform, appId: args.appId });
    await this.db().customerPushSubscription.upsert({
      where: { endpoint: device.endpoint },
      create: {
        tenantId: brand.tenantId,
        brandId: brand.id,
        locationId,
        ...device,
        marketingOptIn: !!args.marketingOptIn,
      },
      update: {
        ...device,
        tenantId: brand.tenantId,
        brandId: brand.id,
        ...(locationId ? { locationId } : {}),
        isActive: true,
        revokedAt: null,
        // The app sends its current toggle on every launch, so it is the
        // source of truth here — unlike subscribe(), which only ever adds.
        ...(args.marketingOptIn === undefined ? {} : { marketingOptIn: !!args.marketingOptIn }),
      },
    });
    return { ok: true };
  }

  /** Offers on or off for one browser or install. The endpoint is the
   *  credential, as it is for unsubscribe. */
  async preferences(endpoint: string, marketingOptIn: boolean): Promise<{ ok: true }> {
    await this.db().customerPushSubscription.updateMany({
      where: { endpoint },
      data: { marketingOptIn: !!marketingOptIn },
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

  /** The columns that say what kind of device this is. Throws on a request
   *  that is neither a browser subscription nor an app token. */
  private deviceFrom(args: {
    endpoint?: string | null;
    p256dh?: string | null;
    auth?: string | null;
    expoToken?: string | null;
    platform?: string | null;
    appId?: string | null;
  }) {
    if (args.expoToken) {
      if (!isExpoToken(args.expoToken)) throw new BadRequestException("Not an Expo push token");
      const platform = args.platform === "ios" || args.platform === "android" ? args.platform : null;
      return {
        kind: "EXPO",
        endpoint: args.expoToken,
        p256dh: null,
        auth: null,
        platform,
        appId: args.appId ? String(args.appId).slice(0, 150) : null,
      };
    }
    if (!args.endpoint || !/^https:\/\//.test(args.endpoint) || !args.p256dh || !args.auth) {
      throw new BadRequestException("A push endpoint and keys are required");
    }
    return { kind: "WEB", endpoint: args.endpoint, p256dh: args.p256dh, auth: args.auth, platform: "web" };
  }

  // ── Order stages ──────────────────────────────────────────────────────────

  /** A tenant's automation rows, keyed by trigger. */
  async automationsFor(tenantId: string): Promise<Map<string, AutomationRow>> {
    const rows: AutomationRow[] = await this.db().pushAutomation.findMany({ where: { tenantId } });
    return new Map(rows.map((r) => [r.trigger, r]));
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
    /** Only this device — catching one late subscriber up (subscribe()). */
    onlySubscriptionId?: string;
  }): Promise<void> {
    try {
      // Every other status is internal bookkeeping. Buzzing someone's phone
      // for PENDING_DISPATCH would teach them to turn notifications off.
      if (!isPushTrigger(args.status) || args.status === REVIEW_TRIGGER) return;
      const trigger: PushTrigger = args.status;

      const links = await this.db().customerPushOrder.findMany({
        where: {
          orderId: args.orderId,
          ...(args.onlySubscriptionId ? { subscriptionId: args.onlySubscriptionId } : {}),
          subscription: { isActive: true },
        },
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

      // RIDER_ARRIVED is overloaded: before pickup it means a courier is at
      // the SHOP; only after outForDeliveryAt is stamped is our driver at the
      // customer's door. "They're outside with your order" while the food is
      // still on the pass would send someone to an empty doorstep.
      if (trigger === "RIDER_ARRIVED") {
        const order = await this.db().order.findUnique({
          where: { id: args.orderId },
          select: { outForDeliveryAt: true },
        });
        if (!order?.outForDeliveryAt) {
          this.logger.log(`customer push RIDER_ARRIVED order=${args.orderId} — courier at the shop, not the door`);
          return;
        }
      }

      const first = links[0].subscription;
      const automations = await this.automationsFor(first.tenantId);

      // Queued before the stage message, so switching off "Delivered" never
      // also switches off the review ask that follows it.
      if (trigger === "COMPLETED") {
        await this.queueReviewRequest(first.tenantId, args.orderId, automations.get(REVIEW_TRIGGER));
      }

      const branding = await this.brandingFor(first);
      const ref = args.displayId ?? (args.orderNumber ? `#${args.orderNumber}` : null);
      const message = resolveMessage({
        trigger,
        fulfillmentType: args.fulfillmentType,
        row: automations.get(trigger),
        orderRef: ref,
        shopName: branding.name,
      });
      if (!message) {
        this.logger.log(`customer push ${args.status} order=${args.orderId} — switched off by the restaurant`);
        return;
      }

      // Prefer a path a real page told us about; fall back to the derived one
      // only if no subscriber recorded theirs. When neither is available the
      // url is omitted entirely and the service worker opens "/" — an earlier
      // version invented /order/status/<id>, a route that does not exist, so
      // every tap on a slug-less location opened a 404.
      const tapTarget =
        safePath(links.find((l: any) => l.trackPath)?.trackPath) ??
        (args.storefrontSlug
          ? `/order/${args.storefrontSlug}/status/${args.orderId}`
          : null);

      const result = await this.sendTo(
        links.map((l: any) => l.subscription),
        {
          ...message,
          // The restaurant's logo on the lock screen, not ours.
          icon: branding.icon,
          // Collapse on the order, so three quick transitions leave one
          // notification in the shade rather than a stack of stale ones.
          tag: `order-${args.orderId}`,
          data: { orderId: args.orderId, status: args.status },
          urlFor: () => tapTarget,
        },
      );
      this.logger.log(
        `customer push ${args.status} order=${args.orderId} delivered=${result.delivered}/${links.length} tap=${tapTarget ?? "(none)"}`,
      );
    } catch (e: any) {
      this.logger.error(`customer push for ${args.orderId} failed: ${e?.message ?? e}`);
    }
  }

  /** One ask per order, however many times COMPLETED fires — upsert on the
   *  unique orderId rather than create-and-catch. */
  private async queueReviewRequest(tenantId: string, orderId: string, businessRow?: AutomationRow | null) {
    const order = await this.db().order.findUnique({
      where: { id: orderId },
      select: { locationId: true, location: { select: { timezone: true } } },
    });
    const locationRow = await this.locationReviewFor(order?.locationId);
    const row = effectiveReviewRow(businessRow, locationRow);
    if (!isEnabled(REVIEW_TRIGGER, row)) return;
    const dueAt = fitSendWindow(
      new Date(Date.now() + reviewDelayMinutes(row) * 60_000),
      order?.location?.timezone || "Europe/London",
      locationRow?.sendFromHour ?? null,
      locationRow?.sendUntilHour ?? null,
    );
    await this.db().pushReviewRequest.upsert({
      where: { orderId },
      create: { tenantId, orderId, dueAt },
      update: {},
    });
  }

  /** A location's own review-ask settings, or null to follow the business. */
  async locationReviewFor(locationId?: string | null): Promise<LocationReviewRow | null> {
    if (!locationId) return null;
    return (await this.db().pushLocationReview.findUnique({ where: { locationId } })) ?? null;
  }

  // ── Sending ───────────────────────────────────────────────────────────────

  /**
   * Send one push to many subscriptions, browsers and app installs alike.
   * Never throws; returns how many the push services accepted.
   */
  async sendTo(subs: any[], content: PushContent): Promise<{ delivered: number; failed: number }> {
    const web = subs.filter((s) => (s.kind ?? "WEB") === "WEB");
    const apps = subs.filter((s) => s.kind === "EXPO");
    let delivered = 0;

    if (web.length) {
      if (!this.ensureVapid()) {
        this.logger.warn(`VAPID keys not set — ${web.length} browser push(es) skipped`);
      } else {
        for (let i = 0; i < web.length; i += WEB_CONCURRENCY) {
          const chunk = web.slice(i, i + WEB_CONCURRENCY);
          const results = await Promise.all(
            chunk.map((sub) => this.deliver(sub, this.webPayload(content, sub))),
          );
          delivered += results.filter(Boolean).length;
        }
      }
    }

    for (let i = 0; i < apps.length; i += EXPO_BATCH) {
      delivered += await this.deliverExpo(apps.slice(i, i + EXPO_BATCH), content);
    }

    return { delivered, failed: subs.length - delivered };
  }

  private webPayload(content: PushContent, sub: any): string {
    const url = content.urlFor?.(sub) ?? null;
    return this.buildPayload({
      title: content.title,
      body: content.body,
      ...(content.icon ? { icon: content.icon } : {}),
      ...(content.tag ? { tag: content.tag } : {}),
      data: { ...(content.data ?? {}), ...(url ? { url } : {}) },
    });
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

  /** Name and logo of the shop a subscription belongs to — the brand when it
   *  came through a brand storefront, else the location. */
  async brandingFor(sub: any): Promise<{ name: string | null; icon: string | null }> {
    const out = { name: null as string | null, icon: null as string | null };
    if (!sub) return out;
    try {
      if (sub.brandId) {
        const brand = await this.db().brand.findUnique({
          where: { id: sub.brandId },
          select: { name: true, logoUrl: true },
        });
        out.name = brand?.name ?? null;
        out.icon = this.usableIcon(brand?.logoUrl);
      }
      // Fall through to the location when the brand's logo is a data URL —
      // it may well have a usable one.
      if (sub.locationId && (!out.icon || !out.name)) {
        const loc = await this.db().location.findUnique({
          where: { id: sub.locationId },
          select: { name: true, logoUrl: true },
        });
        out.name = out.name ?? loc?.name ?? null;
        out.icon = out.icon ?? this.usableIcon(loc?.logoUrl);
      }
    } catch {
      /* a push without a logo beats no push */
    }
    return out;
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
        await this.revoke([sub.id]);
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

  /**
   * Up to 100 app installs in one request to Expo.
   *
   * Expo answers HTTP 200 even when individual messages failed; the verdict is
   * per ticket, in the same order as the messages. DeviceNotRegistered is the
   * app-world 410 — uninstalled, or notifications turned off — and gets the
   * same treatment.
   */
  private async deliverExpo(subs: any[], content: PushContent): Promise<number> {
    const messages = subs.map((sub) => {
      const url = content.urlFor?.(sub) ?? null;
      return {
        to: sub.endpoint,
        title: content.title,
        body: content.body,
        sound: "default",
        priority: "high",
        data: { ...(content.data ?? {}), ...(url ? { url } : {}) },
        // iOS groups by thread; on Android the later push replaces the earlier.
        ...(content.tag ? { threadId: content.tag, collapseId: content.tag } : {}),
      };
    });
    try {
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
        Accept: "application/json",
      };
      // Only needed once "enhanced push security" is switched on in Expo.
      if (process.env.EXPO_ACCESS_TOKEN) headers.Authorization = `Bearer ${process.env.EXPO_ACCESS_TOKEN}`;
      const res = await fetch(EXPO_SEND_URL, { method: "POST", headers, body: JSON.stringify(messages) });
      if (!res.ok) {
        this.logger.warn(`Expo push HTTP ${res.status} for ${subs.length} app install(s)`);
        return 0;
      }
      const json = (await res.json().catch(() => null)) as
        | { data?: Array<{ status?: string; message?: string; details?: { error?: string } }> }
        | null;
      const tickets = json?.data ?? [];
      const ok: string[] = [];
      const gone: string[] = [];
      tickets.forEach((t, i) => {
        const sub = subs[i];
        if (!sub) return;
        if (t?.status === "ok") ok.push(sub.id);
        else if (t?.details?.error === "DeviceNotRegistered") gone.push(sub.id);
        else this.logger.warn(`Expo push ticket error: ${t?.message ?? "unknown"} [${t?.details?.error ?? "?"}]`);
      });
      if (ok.length) {
        await this.db()
          .customerPushSubscription.updateMany({ where: { id: { in: ok } }, data: { lastSentAt: new Date() } })
          .catch(() => undefined);
      }
      if (gone.length) await this.revoke(gone);
      return ok.length;
    } catch (e: any) {
      this.logger.warn(`Expo push failed for ${subs.length} app install(s): ${e?.message ?? e}`);
      return 0;
    }
  }

  private async revoke(ids: string[]): Promise<void> {
    await this.db()
      .customerPushSubscription.updateMany({
        where: { id: { in: ids } },
        data: { isActive: false, revokedAt: new Date() },
      })
      .catch(() => undefined);
  }
}
