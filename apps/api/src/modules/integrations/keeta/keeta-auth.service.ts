import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from "@nestjs/common";
import { Cron } from "@nestjs/schedule";
import * as crypto from "crypto";
import { PrismaService } from "../../../infrastructure/database/prisma.service";
import { ActivityLogService } from "../../logs/activity-log.service";
import { CredentialEncryptionService } from "../credential-encryption.service";
import { KeetaApiError, KeetaClientService, type KeetaAuthorizedShop } from "./keeta-client.service";
import { keetaId } from "./keeta-json";

// Phase KT-1 — Keeta merchant authorization (OAuth 2.0, one token per BRAND).
//
// The flow, from Keeta's Merchant Self-Authorization guide:
//
//   1. We send the merchant to merchant.mykeeta.com/…/authorize with our
//      appId, redirectUri and a `state` of our own.
//   2. They approve and pick the stores.
//   3. Keeta hands us a code — by redirecting their browser to redirectUri,
//      AND/OR by pushing webhook event 1 ("Push Oauth2 authorization code").
//      Either carries our `state` back unchanged. The code dies in 10 minutes
//      and works once.
//   4. We exchange it at /base/oauth/token for an access + refresh token.
//   5. /base/authorized/resource/get says which Keeta brand and stores it
//      covers; the operator maps each store to one of our brand × location
//      pairs (KeetaConnectionService).
//
// ── Token rules that shape this file ────────────────────────────────────────
//
//   • Chains get ONE token for the whole Keeta brand; independents one per
//     store. Either way it lives once, on KeetaAuthorization.
//   • Access and refresh tokens BOTH expire at 90 days, together.
//   • A refresh token works ONCE. Refresh, then persist the new pair before
//     anything else can happen — lose it and the brand must re-authorize.
//   • At most one refresh a minute; the old access token lives 60 more minutes.
//   • Keeta advise refreshing 3–5 days early and retrying 3–5 times on failure.
//
// ── The state parameter ─────────────────────────────────────────────────────
//
// It is the only thing that ties an authorization arriving on a PUBLIC
// endpoint to the tenant that started it, so it is signed: an attacker who
// could mint a state could attach their own Keeta brand to someone else's
// account, and every order from it would land on that tenant's board.

const STATE_TTL_MS = 30 * 60_000;
/** Refresh when this close to expiry. Keeta advise 3–5 days. */
const REFRESH_AHEAD_MS = 5 * 24 * 3600_000;
/** Keeta's floor between refreshes of one token. */
const MIN_REFRESH_GAP_MS = 65_000;

export interface KeetaStatePayload {
  tenantId: string;
  brandId?: string;
  locationId?: string;
  /** Expiry, ms since epoch. */
  exp: number;
  nonce: string;
}

@Injectable()
export class KeetaAuthService {
  private readonly logger = new Logger(KeetaAuthService.name);
  /** One refresh in flight per authorization — the refresh token is single-use. */
  private readonly refreshing = new Map<string, Promise<string>>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly client: KeetaClientService,
    private readonly crypto: CredentialEncryptionService,
    @Optional() private readonly activity?: ActivityLogService,
  ) {}

  // ── state ───────────────────────────────────────────────────────────────

  private stateKey(): string {
    // The app secret is server-only and already the root of every Keeta
    // signature; a separate key would be one more thing to forget to set.
    const secret = this.client.webhookSecret() || process.env.JWT_SECRET || "";
    if (!secret) throw new BadRequestException("Keeta is not configured (KEETA_APP_SECRET).");
    return crypto.createHash("sha256").update(`keeta-oauth-state:${secret}`).digest("hex");
  }

  signState(p: Omit<KeetaStatePayload, "exp" | "nonce">): string {
    const payload: KeetaStatePayload = {
      ...p,
      exp: Date.now() + STATE_TTL_MS,
      nonce: crypto.randomBytes(8).toString("hex"),
    };
    const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
    const mac = crypto.createHmac("sha256", this.stateKey()).update(body).digest("base64url");
    return `${body}.${mac}`;
  }

  verifyState(state: string | undefined | null): KeetaStatePayload | null {
    const [body, mac] = String(state ?? "").split(".");
    if (!body || !mac) return null;
    const expected = crypto.createHmac("sha256", this.stateKey()).update(body).digest("base64url");
    const a = Buffer.from(mac);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
    try {
      const p = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as KeetaStatePayload;
      if (!p?.tenantId || !Number.isFinite(p.exp) || p.exp < Date.now()) return null;
      return p;
    } catch {
      return null;
    }
  }

  // ── start / complete ────────────────────────────────────────────────────

  async start(tenantId: string, body: { brandId?: string; locationId?: string }) {
    if (!this.client.configured) {
      throw new BadRequestException(
        "Keeta isn't set up on this server yet (KEETA_APP_ID / KEETA_APP_SECRET).",
      );
    }
    if (!this.client.oauthRedirectUri) {
      throw new BadRequestException(
        "KEETA_OAUTH_REDIRECT_URI is not set. It must match the URL registered on the Keeta app's " +
          '"Push Oauth2 authorization code" setting.',
      );
    }
    if (body.brandId || body.locationId) {
      await this.assertOwned(tenantId, body.brandId, body.locationId);
    }
    const state = this.signState({
      tenantId,
      ...(body.brandId ? { brandId: body.brandId } : {}),
      ...(body.locationId ? { locationId: body.locationId } : {}),
    });
    return { url: this.client.authorizeUrl(state), expiresInMinutes: STATE_TTL_MS / 60_000 };
  }

  /** Codes already exchanged in this process — the redirect and the event-1
   *  webhook can both deliver the same one, and it only works once. */
  private readonly usedCodes = new Map<string, Promise<KeetaCompleteResult>>();

  /**
   * Turn a code into a stored authorization.
   *
   * Called from BOTH delivery paths. Whichever arrives first does the work;
   * the second gets the same result instead of spending a dead code and
   * reporting a failure the merchant would then worry about.
   */
  complete(code: string, state: string | undefined | null): Promise<KeetaCompleteResult> {
    const key = String(code ?? "").trim();
    if (!key) return Promise.reject(new BadRequestException("Missing authorization code"));
    const inFlight = this.usedCodes.get(key);
    if (inFlight) return inFlight;
    const p = this.doComplete(key, state);
    this.usedCodes.set(key, p);
    // Codes die in 10 minutes anyway; forget ours after 15.
    setTimeout(() => this.usedCodes.delete(key), 15 * 60_000).unref?.();
    p.catch(() => this.usedCodes.delete(key));
    return p;
  }

  private async doComplete(code: string, state: string | undefined | null): Promise<KeetaCompleteResult> {
    const st = this.verifyState(state);
    if (!st) {
      // Refused BEFORE the exchange. A code with no valid state belongs to
      // nobody we can name, and exchanging it would only burn it.
      throw new BadRequestException(
        "This Keeta authorization link has expired or was not started from OrderHub. " +
          "Start again from Locations → Brands → Keeta.",
      );
    }

    const tok = await this.client.exchangeCode(code);
    const resources = await this.client.authorizedResources(tok.accessToken);
    const keetaBrandId = keetaId(resources.brandId);
    const shops = (resources.authorizedShops ?? []).map(normaliseShop);

    const issuedAt = new Date(Number(tok.issuedAtTime) || Date.now());
    const expiresAt = new Date(issuedAt.getTime() + (Number(tok.expiresIn) || 7_776_000) * 1000);
    const data = {
      tenantId: st.tenantId,
      keetaBrandId,
      brandName: resources.brandName ?? null,
      keetaUserId: keetaId(resources.userId),
      accessToken: this.seal(tok.accessToken),
      refreshToken: this.seal(tok.refreshToken),
      issuedAt,
      expiresAt,
      status: "active",
      shops: shops as any,
      lastError: null,
    };

    // Re-authorizing a brand REPLACES its token (Keeta issued a new one; the
    // old is as good as gone), so an existing row for the same Keeta brand is
    // updated rather than duplicated — its store connections keep working.
    const existing = keetaBrandId
      ? await this.prisma.keetaAuthorization.findFirst({
          where: { tenantId: st.tenantId, keetaBrandId },
          select: { id: true },
        })
      : null;
    const auth = existing
      ? await this.prisma.keetaAuthorization.update({ where: { id: existing.id }, data })
      : await this.prisma.keetaAuthorization.create({ data });

    // One store and a location to put it on: connect it now rather than
    // making the operator pick the only option there is.
    let connectedShopId: string | null = null;
    if (st.brandId && st.locationId && shops.length === 1) {
      const clash = await this.prisma.brandPlatformConnection.findFirst({
        where: {
          platform: "KEETA",
          externalStoreId: shops[0]!.id,
          NOT: { AND: [{ brandId: st.brandId }, { locationId: st.locationId }] },
          status: { not: "not_connected" },
        },
        select: { id: true },
      });
      if (!clash) {
        await this.upsertConnection({
          tenantId: st.tenantId,
          brandId: st.brandId,
          locationId: st.locationId,
          shopId: shops[0]!.id,
          shopName: shops[0]!.name ?? null,
          authorizationId: auth.id,
          keetaBrandId,
        });
        connectedShopId = shops[0]!.id;
      }
    }

    this.activity?.record({
      tenantId: st.tenantId,
      ...(st.brandId ? { brandId: st.brandId } : {}),
      ...(st.locationId ? { locationId: st.locationId } : {}),
      category: "CONNECTION",
      channel: "KEETA",
      action: "connection.authorize",
      status: "SUCCESS",
      message:
        `Keeta authorized${resources.brandName ? ` for "${resources.brandName}"` : ""} — ` +
        `${shops.length} store(s)` +
        (connectedShopId ? `, store ${connectedShopId} connected` : ", pick which store goes where"),
    });
    this.logger.log(
      `Keeta authorization ${auth.id} for tenant ${st.tenantId}: brand ${keetaBrandId ?? "?"}, ${shops.length} shop(s)`,
    );
    return {
      authorizationId: auth.id,
      brandName: resources.brandName ?? null,
      shops,
      connectedShopId,
      brandId: st.brandId ?? null,
      locationId: st.locationId ?? null,
    };
  }

  /** Create or refresh the brand × location → Keeta store link. */
  async upsertConnection(args: {
    tenantId: string;
    brandId: string;
    locationId: string;
    shopId: string;
    shopName: string | null;
    authorizationId: string;
    keetaBrandId: string | null;
  }) {
    const prev = await this.prisma.brandPlatformConnection.findFirst({
      where: { brandId: args.brandId, locationId: args.locationId, platform: "KEETA" },
      select: { metadata: true },
    });
    const metadata = {
      ...((prev?.metadata as any) ?? {}),
      keetaAuthorizationId: args.authorizationId,
      keetaShopName: args.shopName,
    };
    return this.prisma.brandPlatformConnection.upsert({
      where: {
        brandId_locationId_platform: {
          brandId: args.brandId,
          locationId: args.locationId,
          platform: "KEETA",
        },
      },
      create: {
        tenantId: args.tenantId,
        brandId: args.brandId,
        locationId: args.locationId,
        platform: "KEETA",
        status: "connected",
        externalStoreId: args.shopId,
        externalBrandId: args.keetaBrandId,
        metadata: metadata as any,
      },
      update: {
        status: "connected",
        externalStoreId: args.shopId,
        externalBrandId: args.keetaBrandId,
        lastError: null,
        metadata: metadata as any,
      },
    });
  }

  // ── tokens ──────────────────────────────────────────────────────────────

  /** Access token for the authorization behind one of OUR connections. */
  async tokenForConnection(conn: { metadata: unknown; externalStoreId?: string | null }): Promise<string> {
    const authId = String(((conn.metadata as any) ?? {}).keetaAuthorizationId ?? "");
    if (!authId) {
      throw new BadRequestException(
        `Keeta store ${conn.externalStoreId ?? "?"} has no authorization — reconnect Keeta for it.`,
      );
    }
    return this.accessToken(authId);
  }

  /** A live access token, refreshed first if it is close to expiry. */
  async accessToken(authorizationId: string): Promise<string> {
    const auth = await this.prisma.keetaAuthorization.findUnique({ where: { id: authorizationId } });
    if (!auth) throw new NotFoundException("Keeta authorization not found");
    if (auth.status === "revoked") {
      throw new BadRequestException(
        `The merchant revoked OrderHub's Keeta authorization${auth.brandName ? ` for "${auth.brandName}"` : ""}. ` +
          "Re-authorize from Locations → Brands → Keeta.",
      );
    }
    if (auth.expiresAt.getTime() - Date.now() > REFRESH_AHEAD_MS) return this.unseal(auth.accessToken);
    return this.refresh(authorizationId);
  }

  /**
   * Refresh one authorization's tokens. Serialised per authorization in this
   * process, and guarded in the database by lastRefreshAt, because a second
   * concurrent refresh would spend a refresh token the first already spent.
   */
  refresh(authorizationId: string): Promise<string> {
    const inFlight = this.refreshing.get(authorizationId);
    if (inFlight) return inFlight;
    const p = this.doRefresh(authorizationId).finally(() => this.refreshing.delete(authorizationId));
    this.refreshing.set(authorizationId, p);
    return p;
  }

  private async doRefresh(authorizationId: string): Promise<string> {
    const auth = await this.prisma.keetaAuthorization.findUnique({ where: { id: authorizationId } });
    if (!auth) throw new NotFoundException("Keeta authorization not found");

    // Another instance refreshed within Keeta's one-a-minute window: its new
    // access token is already stored and good.
    if (auth.lastRefreshAt && Date.now() - auth.lastRefreshAt.getTime() < MIN_REFRESH_GAP_MS) {
      return this.unseal(auth.accessToken);
    }

    try {
      const tok = await this.client.refreshToken(this.unseal(auth.refreshToken));
      const issuedAt = new Date(Number(tok.issuedAtTime) || Date.now());
      // Persist IMMEDIATELY. The refresh token we just used is dead; if this
      // write were lost, so would the brand's only way back in be.
      await this.prisma.keetaAuthorization.update({
        where: { id: authorizationId },
        data: {
          accessToken: this.seal(tok.accessToken),
          refreshToken: this.seal(tok.refreshToken),
          issuedAt,
          expiresAt: new Date(issuedAt.getTime() + (Number(tok.expiresIn) || 7_776_000) * 1000),
          lastRefreshAt: new Date(),
          status: "active",
          lastError: null,
        },
      });
      this.logger.log(`Keeta token refreshed for authorization ${authorizationId}`);
      return tok.accessToken;
    } catch (err: any) {
      const msg = err instanceof KeetaApiError ? `${err.keetaCode}: ${err.keetaMessage}` : String(err?.message ?? err);
      await this.prisma.keetaAuthorization
        .update({
          where: { id: authorizationId },
          data: { status: "refresh_failed", lastError: `Refresh failed — ${msg}` },
        })
        .catch(() => undefined);
      this.activity?.record({
        tenantId: auth.tenantId,
        category: "CONNECTION",
        channel: "KEETA",
        action: "connection.token_refresh",
        status: "ERROR",
        message:
          `Keeta token refresh failed${auth.brandName ? ` for "${auth.brandName}"` : ""}: ${msg}. ` +
          "Orders keep arriving by webhook, but accepting them from OrderHub will fail once the token expires " +
          `(${auth.expiresAt.toISOString().slice(0, 10)}). Re-authorize if this persists.`,
      });
      // The current access token may still be good for days — use it rather
      // than failing a call that would have worked.
      if (auth.expiresAt.getTime() > Date.now()) return this.unseal(auth.accessToken);
      throw err;
    }
  }

  /** Daily: refresh everything inside the window, so no call has to. */
  @Cron("0 17 3 * * *")
  async refreshDue(): Promise<number> {
    if (!this.client.configured) return 0;
    const due = await this.prisma.keetaAuthorization
      .findMany({
        where: {
          status: { in: ["active", "refresh_failed"] },
          expiresAt: { lt: new Date(Date.now() + REFRESH_AHEAD_MS) },
        },
        select: { id: true },
        take: 200,
      })
      .catch(() => []);
    let ok = 0;
    for (const a of due) {
      // Keeta's advice: 3–5 attempts. Spread out, not hammered.
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          await this.refresh(a.id);
          ok++;
          break;
        } catch {
          await new Promise((r) => setTimeout(r, 70_000));
        }
      }
    }
    return ok;
  }

  // ── authorization-change webhooks (1301 / 1302 / 1303) ─────────────────

  /** 1301 — a store was added to an existing brand authorization. */
  async onShopAuthorized(msg: { shopId?: unknown; shopName?: string; authId?: unknown }) {
    const shopId = keetaId(msg.shopId);
    if (!shopId) return;
    // The token is unchanged; only its scope grew. 1301 names the store and
    // an authId but NOT the brand, and authId is nothing Keeta ever gave us
    // at exchange time — so there is no direct way to tell which of our
    // authorizations grew. Re-reading every active one's store list is the
    // honest answer; the list is what the connect picker offers, and there
    // are few authorizations per deployment.
    this.logger.log(`Keeta: store ${shopId} (${msg.shopName ?? "?"}) added to an authorization`);
    const auths = await this.prisma.keetaAuthorization.findMany({
      where: { status: "active" },
      select: { id: true },
      orderBy: { updatedAt: "desc" },
      take: 50,
    });
    for (const a of auths) {
      await this.reloadShops(a.id).catch(() => undefined);
    }
  }

  /** 1302 — a store was removed from a brand's authorization. */
  async onShopDeauthorized(msg: { shopId?: unknown; shopName?: string }) {
    const shopId = keetaId(msg.shopId);
    if (!shopId) return;
    const conns = await this.prisma.brandPlatformConnection.findMany({
      where: { platform: "KEETA", externalStoreId: shopId, status: { not: "not_connected" } },
      select: { id: true, tenantId: true, brandId: true, locationId: true },
    });
    for (const c of conns) {
      await this.prisma.brandPlatformConnection.update({
        where: { id: c.id },
        data: {
          status: "error",
          lastError: "The merchant removed this store from OrderHub's Keeta authorization.",
        },
      });
      this.activity?.record({
        tenantId: c.tenantId,
        brandId: c.brandId,
        locationId: c.locationId,
        category: "CONNECTION",
        channel: "KEETA",
        action: "connection.deauthorized",
        status: "ERROR",
        message: `Keeta store ${shopId} was removed from OrderHub's authorization — orders for it will stop.`,
      });
    }
  }

  /** 1303 — the whole brand revoked us. Keeta: "treat the token as invalid". */
  async onBrandRevoked(msg: { brandId?: unknown; brandName?: string; shopIds?: unknown }) {
    const keetaBrandId = keetaId(msg.brandId);
    if (!keetaBrandId) return;
    const auths = await this.prisma.keetaAuthorization.findMany({
      where: { keetaBrandId },
      select: { id: true, tenantId: true },
    });
    for (const a of auths) {
      await this.prisma.keetaAuthorization.update({
        where: { id: a.id },
        data: { status: "revoked", lastError: "Revoked by the merchant in Keeta." },
      });
      const conns = await this.prisma.brandPlatformConnection.findMany({
        where: {
          platform: "KEETA",
          metadata: { path: ["keetaAuthorizationId"], equals: a.id },
        },
        select: { id: true, brandId: true, locationId: true },
      });
      for (const c of conns) {
        await this.prisma.brandPlatformConnection.update({
          where: { id: c.id },
          data: { status: "error", lastError: "The merchant revoked OrderHub's Keeta authorization." },
        });
      }
      this.activity?.record({
        tenantId: a.tenantId,
        category: "CONNECTION",
        channel: "KEETA",
        action: "connection.revoked",
        status: "ERROR",
        message:
          `Keeta brand "${msg.brandName ?? keetaBrandId}" revoked OrderHub's authorization — ` +
          `${conns.length} store connection(s) stopped. Re-authorize to reconnect.`,
      });
    }
  }

  /** Re-read which stores an authorization covers. */
  async reloadShops(authorizationId: string) {
    const token = await this.accessToken(authorizationId);
    const res = await this.client.authorizedResources(token);
    const shops = (res.authorizedShops ?? []).map(normaliseShop);
    await this.prisma.keetaAuthorization.update({
      where: { id: authorizationId },
      data: { shops: shops as any, brandName: res.brandName ?? undefined },
    });
    return shops;
  }

  async list(tenantId: string) {
    const rows = await this.prisma.keetaAuthorization.findMany({
      where: { tenantId },
      orderBy: { updatedAt: "desc" },
    });
    return rows.map((r) => ({
      id: r.id,
      keetaBrandId: r.keetaBrandId,
      brandName: r.brandName,
      status: r.status,
      expiresAt: r.expiresAt,
      lastRefreshAt: r.lastRefreshAt,
      lastError: r.lastError,
      shops: (r.shops as any[]) ?? [],
    }));
  }

  // ── helpers ─────────────────────────────────────────────────────────────

  private seal(token: string): string {
    return JSON.stringify(this.crypto.encrypt({ token }));
  }

  private unseal(stored: string): string {
    try {
      const parsed = JSON.parse(stored);
      const plain = this.crypto.decrypt(parsed);
      return String((plain as any)?.token ?? "");
    } catch {
      // A row written before encryption was configured holds the raw token.
      return stored;
    }
  }

  private async assertOwned(tenantId: string, brandId?: string, locationId?: string) {
    if (brandId) {
      const b = await this.prisma.brand.findFirst({
        where: { id: brandId, tenantId, deletedAt: null },
        select: { id: true },
      });
      if (!b) throw new NotFoundException("Brand not found");
    }
    if (locationId) {
      // Location has no tenantId of its own — it hangs off the brand.
      const l = await this.prisma.location.findFirst({
        where: { id: locationId, deletedAt: null, brand: { tenantId } },
        select: { id: true },
      });
      if (!l) throw new NotFoundException("Location not found");
    }
  }
}

export interface KeetaShopSummary {
  id: string;
  name: string | null;
  address: string | null;
  latitude: number | null;
  longitude: number | null;
}

export interface KeetaCompleteResult {
  authorizationId: string;
  brandName: string | null;
  shops: KeetaShopSummary[];
  connectedShopId: string | null;
  brandId: string | null;
  locationId: string | null;
}

export function normaliseShop(s: KeetaAuthorizedShop): KeetaShopSummary {
  const lat = Number(s.latitude);
  const lng = Number(s.longitude);
  return {
    id: keetaId(s.id) ?? "",
    name: s.name ?? null,
    address: s.address ?? null,
    latitude: Number.isFinite(lat) ? lat : null,
    longitude: Number.isFinite(lng) ? lng : null,
  };
}
