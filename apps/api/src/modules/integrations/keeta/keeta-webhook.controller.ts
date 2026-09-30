import { Controller, Get, HttpCode, Logger, Post, Query, Req, Res } from "@nestjs/common";
import type { RawBodyRequest } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { ApiExcludeController } from "@nestjs/swagger";
import type { Request, Response } from "express";
import * as crypto from "crypto";
import { Public } from "../../../common/decorators/public.decorator";
import { BillingExempt } from "../../../common/guards/billing.guard";
import { PrismaService } from "../../../infrastructure/database/prisma.service";
import { KeetaAuthService } from "./keeta-auth.service";
import { KeetaClientService } from "./keeta-client.service";
import { keetaId, parseKeetaJson } from "./keeta-json";
import { KeetaMenuPublishService } from "./keeta-menu-publish.service";
import { KeetaOrderService } from "./keeta-order.service";
import { verifyKeetaWebhookSig } from "./keeta-signature";
import { KeetaStoreService } from "./keeta-store.service";
import { KEETA_WEBHOOK_IPS, KeetaWebhookLogService } from "./keeta-webhook-log.service";

// Phase KT-1/2 — every Keeta webhook, on ONE URL.
//
//   POST /api/v1/integrations/keeta/webhook
//
// Keeta configure a URL per event id; we register this same URL for all of
// them (POST integrations/keeta/register-webhooks does it by API). The body
// is an envelope:
//
//   { sig, eventId, appId, messageId, shopId, message: "<JSON STRING>", timestamp }
//
// `message` is a JSON-encoded STRING whose contents are the per-event schema.
// Event 1 (the OAuth code) is the exception — a flat { code, state, appId,
// timestamp, sig } — and Keeta's own docs disagree about whether it is a GET
// or a POST, so both are accepted (and GET also serves the browser redirect).
//
// ── Replies ─────────────────────────────────────────────────────────────────
//
// Always HTTP 200 with {"code":0,…}: that is Keeta's definition of "received".
// Keeta also send EMPTY heartbeat POSTs and expect the same success back.
// A non-zero code makes Keeta retry (≈3 times, a minute apart), so it is
// returned in exactly one case — a NEW ORDER we failed to save for a reason
// another attempt could fix. Everything else a retry cannot change.
//
// ── Signature ───────────────────────────────────────────────────────────────
//
// "Developers must verify message signatures" — but the recipe is not
// documented. keetaWebhookSigCandidates tries the plausible ones and the
// result is logged per delivery. KEETA_WEBHOOK_SIG_MODE:
//   observe (default) — process regardless, record whether it matched;
//   enforce           — drop anything that doesn't match.
// Switch to enforce once a real delivery has shown which recipe Keeta use.
// The appId check and Keeta's published IP list are recorded alongside.

const OK = { code: 0, message: "success", data: {} };

@ApiExcludeController()
@BillingExempt() // order intake is never gated by our own billing status
@Controller({ path: "integrations/keeta", version: "1" })
export class KeetaWebhookController {
  private readonly logger = new Logger(KeetaWebhookController.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly client: KeetaClientService,
    private readonly auth: KeetaAuthService,
    private readonly orders: KeetaOrderService,
    private readonly menus: KeetaMenuPublishService,
    private readonly store: KeetaStoreService,
    private readonly seen: KeetaWebhookLogService,
  ) {}

  /** The URL Keeta sign against, if the recipe includes it. */
  webhookUrl(): string {
    const explicit = (process.env.KEETA_WEBHOOK_URL ?? "").trim();
    if (explicit) return explicit;
    const api = String(this.config.get<string>("app.apiUrl") ?? "").replace(/\/+$/, "");
    return `${api}/api/v1/integrations/keeta/webhook`;
  }

  @Public()
  @Post("webhook")
  @HttpCode(200)
  async webhook(@Req() req: RawBodyRequest<Request>) {
    const raw = (req.rawBody ?? Buffer.from(req.body ? JSON.stringify(req.body) : "")).toString("utf8").trim();
    // Heartbeat: an empty packet, answered with success.
    if (!raw || raw === "{}") return OK;

    let body: Record<string, any>;
    try {
      body = parseKeetaJson(raw);
    } catch (e: any) {
      this.logger.error(`Keeta webhook body is not JSON: ${e?.message} — ${raw.slice(0, 300)}`);
      return OK; // malformed on every retry too
    }
    if (!body || typeof body !== "object") return OK;

    // Event 1 arrives flat, without an envelope.
    if (body.eventId == null && body.code && !body.message) {
      return this.handleAuthCode(body, req);
    }
    return this.handleEnvelope(body, req);
  }

  /**
   * The OAuth code, by GET. Two very different callers:
   *   • Keeta's SERVER (event 1 "HTTP GET") — has `sig`; wants {"code":0}.
   *   • the MERCHANT'S BROWSER after approving — no `sig`; wants a page.
   */
  @Public()
  @Get(["oauth/callback", "webhook"])
  async oauthCallback(
    @Query() q: Record<string, string>,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    if (!q?.code) {
      // A GET with nothing on it is a reachability check.
      res.status(200).json(OK);
      return;
    }
    if (q.sig) {
      res.status(200).json(await this.handleAuthCode(q, req));
      return;
    }
    const app = String(this.config.get<string>("app.appUrl") ?? "").replace(/\/+$/, "");
    const st = this.auth.verifyState(q.state);
    const back = st?.locationId
      ? `${app}/dashboard/locations/${encodeURIComponent(st.locationId)}/brands`
      : `${app}/dashboard/locations`;
    try {
      const r = await this.auth.complete(q.code, q.state);
      const params = new URLSearchParams({
        keeta: r.connectedShopId ? "connected" : "authorized",
        keetaAuthorizationId: r.authorizationId,
        ...(r.brandId ? { brandId: r.brandId } : {}),
      });
      res.redirect(302, `${back}?${params.toString()}`);
    } catch (e: any) {
      const params = new URLSearchParams({ keeta: "error", keetaError: String(e?.message ?? e).slice(0, 300) });
      res.redirect(302, `${back}?${params.toString()}`);
    }
  }

  private async handleAuthCode(body: Record<string, any>, req: Request) {
    const sig = this.checkSig(body, req);
    this.seen.record({
      at: new Date().toISOString(),
      eventId: 1,
      messageId: null,
      shopId: null,
      orderViewId: null,
      sigOk: sig.ok,
      sigVariant: sig.variant,
      sourceIp: sig.ip,
      ipListed: sig.ipListed,
      handled: "oauth_code",
      preview: JSON.stringify({ ...body, code: "<redacted>" }).slice(0, 500),
    });
    if (!sig.accept) return OK;
    try {
      await this.auth.complete(String(body.code), body.state ? String(body.state) : null);
    } catch (e: any) {
      // The browser redirect may already have spent this code — complete()
      // dedupes that — or the state was not ours. Either way, not retryable.
      this.logger.warn(`Keeta auth code (event 1) not completed: ${e?.message}`);
    }
    return OK;
  }

  private async handleEnvelope(body: Record<string, any>, req: Request) {
    const eventId = Number(body.eventId);
    let msg: Record<string, any> = {};
    if (typeof body.message === "string" && body.message.trim()) {
      try {
        msg = parseKeetaJson(body.message);
      } catch {
        this.logger.error(`Keeta event ${eventId}: message is not JSON — ${String(body.message).slice(0, 300)}`);
      }
    } else if (body.message && typeof body.message === "object") {
      msg = body.message;
    }
    const shopId = keetaId(msg.shopId ?? msg?.orderInfo?.merchantOrder?.shopId ?? body.shopId);
    const orderViewId = keetaId(
      msg.orderViewId ?? msg?.orderInfo?.merchantOrder?.orderViewId ?? msg?.merchantOrder?.orderViewId,
    );

    const sig = this.checkSig(body, req);
    const messageId = keetaId(body.messageId);
    let handled = "ignored";
    let reply: Record<string, unknown> = OK;

    // Dedup on Keeta's messageId. A retry of something we already processed
    // successfully is acknowledged and skipped; one whose first attempt
    // FAILED is processed again, which is the whole point of the retry.
    const eventKey = messageId ?? `${eventId}:${crypto.createHash("sha256").update(String(body.message ?? "")).digest("hex").slice(0, 32)}`;
    const prior = await this.prisma.webhookEvent
      .findUnique({ where: { platform_externalEventId: { platform: "KEETA", externalEventId: eventKey } } })
      .catch(() => null);
    if (prior?.processedAt && !prior.processingError) {
      handled = "duplicate";
    } else if (!sig.accept) {
      handled = "rejected_sig";
    } else {
      try {
        handled = await this.dispatch(eventId, msg, shopId);
        if (handled === "retry") reply = { code: 1, message: "temporary failure, please retry", data: {} };
      } catch (e: any) {
        handled = `error: ${String(e?.message ?? e).slice(0, 200)}`;
        this.logger.error(`Keeta event ${eventId} (${orderViewId ?? shopId ?? "-"}) failed: ${e?.message}`);
        // A new order is the one thing worth Keeta retrying.
        if (eventId === 1001) reply = { code: 1, message: "temporary failure, please retry", data: {} };
      }
      const failed = handled === "retry" || handled.startsWith("error");
      await this.prisma.webhookEvent
        .upsert({
          where: { platform_externalEventId: { platform: "KEETA", externalEventId: eventKey } },
          create: {
            platform: "KEETA",
            externalEventId: eventKey,
            signature: String(body.sig ?? "") || null,
            rawPayload: { ...body, message: msg } as any,
            processedAt: new Date(),
            processingError: failed ? handled : null,
            metadata: { eventId, shopId, orderViewId, sigOk: sig.ok, sigVariant: sig.variant } as any,
          },
          update: {
            processedAt: new Date(),
            processingError: failed ? handled : null,
            retryCount: { increment: 1 },
          },
        })
        .catch((e) => this.logger.warn(`Keeta webhook bookkeeping failed: ${e?.message}`));
    }

    this.seen.record({
      at: new Date().toISOString(),
      eventId: Number.isFinite(eventId) ? eventId : null,
      messageId,
      shopId,
      orderViewId,
      sigOk: sig.ok,
      sigVariant: sig.variant,
      sourceIp: sig.ip,
      ipListed: sig.ipListed,
      handled,
      preview: JSON.stringify(msg).slice(0, 2000),
    });
    this.logger.log(
      `Keeta event ${eventId} shop=${shopId ?? "-"} order=${orderViewId ?? "-"} sig=${sig.ok ? sig.variant : "NO MATCH"} ` +
        `ip=${sig.ip ?? "?"}${sig.ipListed ? "" : " (not on Keeta's list)"} → ${handled}`,
    );
    return reply;
  }

  private async dispatch(eventId: number, msg: Record<string, any>, shopId: string | null): Promise<string> {
    switch (eventId) {
      case 1001: {
        // The message IS FindMerchantOrderByViewIdResp — {orderInfo: {...}}.
        // Accept a bare orderInfo too, in case the envelope differs.
        const info = msg.orderInfo ?? (msg.merchantOrder || msg.baseOrder ? msg : null);
        if (!info) return "no_order_in_message";
        const r = await this.orders.ingest(info, shopId);
        return r.retry ? "retry" : (r.reason ?? "ingested");
      }
      case 1002:
        await this.orders.onAccepted(msg);
        return "accepted";
      case 1003:
        await this.orders.onCompleted(msg);
        return "completed";
      case 1004:
        await this.orders.onCancelled(msg);
        return "cancelled";
      case 1005:
        await this.orders.onRefund("full", msg);
        return "refund";
      case 1006:
        await this.orders.onDeliveryStatus(msg);
        return "delivery_status";
      case 1007:
        await this.orders.onRefund("partial", msg);
        return "partial_refund";
      case 1101:
        await this.store.onHoursChanged(msg);
        return "hours_changed";
      case 1102:
        await this.store.onStoreStatus(msg);
        return "store_status";
      case 1201:
        await this.menus.onPictureResult({ shopId, ...msg });
        return "picture_result";
      case 1202:
        await this.menus.onMenuSyncResult({ shopId, ...msg });
        return "menu_sync_result";
      case 1301:
        await this.auth.onShopAuthorized(msg);
        return "shop_authorized";
      case 1302:
        await this.auth.onShopDeauthorized(msg);
        return "shop_deauthorized";
      case 1303:
        await this.auth.onBrandRevoked(msg);
        return "brand_revoked";
      case 1:
        if (msg.code) {
          await this.auth.complete(String(msg.code), msg.state ? String(msg.state) : null).catch(() => undefined);
        }
        return "oauth_code";
      default:
        this.logger.warn(`Keeta webhook with unknown eventId ${eventId}`);
        return "unknown_event";
    }
  }

  /** Signature, appId and source IP — recorded always, enforced on request. */
  private checkSig(body: Record<string, any>, req: Request) {
    const ip = sourceIp(req);
    const ipListed = !!ip && KEETA_WEBHOOK_IPS.has(ip);
    const appIdOk = !body.appId || !this.client.appId || String(body.appId) === this.client.appId;
    const urls = [this.webhookUrl(), requestUrl(req), `${this.webhookUrl().replace(/\/webhook$/, "")}/oauth/callback`];
    const { ok, variant } = verifyKeetaWebhookSig(body, this.client.webhookSecret(), urls);
    const enforce = process.env.KEETA_WEBHOOK_SIG_MODE === "enforce";
    if (!appIdOk) {
      this.logger.warn(`Keeta webhook for appId ${body.appId}, not ours (${this.client.appId}) — ignored`);
    }
    return { ok, variant, ip, ipListed, accept: appIdOk && (ok || !enforce) };
  }
}

/** The first hop of X-Forwarded-For — Render's proxy sits in front of us. */
function sourceIp(req: Request): string | null {
  const xff = String(req.headers["x-forwarded-for"] ?? "").split(",")[0]?.trim();
  return xff || req.ip || null;
}

/** This request's own URL without its query string, as Keeta addressed it. */
function requestUrl(req: Request): string {
  const proto = String(req.headers["x-forwarded-proto"] ?? req.protocol ?? "https").split(",")[0]!.trim();
  const host = String(req.headers["x-forwarded-host"] ?? req.headers.host ?? "").split(",")[0]!.trim();
  const path = String(req.originalUrl ?? req.url ?? "").split("?")[0];
  return host ? `${proto}://${host}${path}` : "";
}
