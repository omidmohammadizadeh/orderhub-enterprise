import { BadRequestException, Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { JwtService } from "@nestjs/jwt";
import type { Prisma } from "@orderhub/database";
import { PrismaService } from "../../../infrastructure/database/prisma.service";
import { CredentialEncryptionService } from "../credential-encryption.service";
import { UberEatsClientService } from "./ubereats-client.service";

// Phase UE-1/2 — merchant OAuth (authorization_code, scope
// eats.pos_provisioning). The operator clicks "Connect Uber Eats" on a
// brand+location, we send them to Uber's consent page with a signed state,
// Uber redirects back to our callback, we exchange the code and store the
// merchant token (encrypted) on the pending BrandPlatformConnection. The
// token is only needed for store discovery + pos_data provisioning; Uber
// user tokens live 30 days and the connect flow re-runs OAuth if expired.

interface StatePayload {
  t: string; // tenantId
  u: string; // userId
  b: string; // brandId
  l: string; // locationId
  purpose: "ubereats_oauth";
}

/**
 * An invite link's payload. Same signing key as the OAuth state above, so the
 * purpose field is load-bearing: without it a 15-minute state could be
 * replayed as a three-day invite, and vice versa.
 */
interface InvitePayload {
  t: string; // tenantId
  b: string; // brandId
  l: string; // locationId
  purpose: "ubereats_invite";
}

/** How long an owner has to open the link before it stops working. */
const INVITE_TTL_HOURS = 72;

@Injectable()
export class UberEatsOauthService {
  private readonly logger = new Logger(UberEatsOauthService.name);

  constructor(
    private readonly config: ConfigService,
    private readonly jwt: JwtService,
    private readonly prisma: PrismaService,
    private readonly credentials: CredentialEncryptionService,
    private readonly client: UberEatsClientService,
  ) {}

  get redirectUri(): string {
    const raw =
      this.config.get<string>("app.platforms.uberEats.redirectUri") ?? "";
    // OAuth sends exactly ONE redirect_uri, but operators sometimes paste a
    // comma-separated list of all the URIs registered on the Uber app. Sending
    // the whole list as a single value makes it match none → Uber's "Sorry"
    // error. Use the first entry, trimmed, so a list can't break the flow.
    return raw.split(",")[0]?.trim() ?? "";
  }

  buildAuthorizeUrl(args: {
    tenantId: string;
    userId: string;
    brandId: string;
    locationId: string;
  }): string {
    if (!this.client.configured) {
      throw new BadRequestException(
        "Uber Eats isn't configured on the server yet (missing client credentials).",
      );
    }
    if (!this.redirectUri) {
      throw new BadRequestException(
        "UBER_EATS_REDIRECT_URI isn't set on the server.",
      );
    }
    const state = this.jwt.sign(
      {
        t: args.tenantId,
        u: args.userId,
        b: args.brandId,
        l: args.locationId,
        purpose: "ubereats_oauth",
      } satisfies StatePayload,
      { expiresIn: "15m" },
    );
    const u = new URL(`${this.client.authBase}/authorize`);
    u.searchParams.set("client_id", this.client.clientId);
    u.searchParams.set("response_type", "code");
    u.searchParams.set("redirect_uri", this.redirectUri);
    // authorization_code only accepts eats.pos_provisioning (eats.store is a
    // client-credentials scope — including it here → invalid_scope). The
    // pos_provisioning merchant token can still list stores: GET
    // /v1/delivery/stores accepts either scope.
    u.searchParams.set("scope", "eats.pos_provisioning");
    u.searchParams.set("state", state);
    return u.toString();
  }

  // ── Owner connection links ───────────────────────────────────────────
  //
  // The operator cannot authorise a store they do not own. Doing it from the
  // dashboard means being signed in to Uber as the client — which is how the
  // wrong account gets attached, since whoever is signed in at that moment is
  // whose stores come back. An invite moves the consent step to the person who
  // actually holds the Uber account: we mint a signed link for one brand at
  // one shop, they open it, they sign in as themselves, and the existing
  // callback does the rest unchanged.
  //
  // The link is a bearer credential. It is signed, it expires, and it refuses
  // to run once the brand is connected — which makes it single-use in
  // practice, so a forwarded copy cannot attach a second Uber account.

  /** Mint a link for the shop owner. Operator-facing. */
  async createInvite(args: {
    tenantId: string;
    brandId: string;
    locationId: string;
  }): Promise<{ url: string; expiresAt: string }> {
    const token = this.jwt.sign(
      {
        t: args.tenantId,
        b: args.brandId,
        l: args.locationId,
        purpose: "ubereats_invite",
      } satisfies InvitePayload,
      { expiresIn: `${INVITE_TTL_HOURS}h` },
    );
    return {
      url: this.publicWebUrl(
        `/connect/uber-eats/${encodeURIComponent(token)}`,
      ).toString(),
      expiresAt: new Date(
        Date.now() + INVITE_TTL_HOURS * 3600_000,
      ).toISOString(),
    };
  }

  /**
   * A URL on the PUBLIC web app, for a link we are about to hand a stranger.
   *
   * APP_URL on the API service is Render's internal service name in at least
   * one environment. "orderhub-web" parses perfectly as a URL and resolves to
   * nothing from the outside, so an owner would receive a link that dies on
   * DNS before it reaches us — which is exactly what happened the first time
   * this shipped. No dot in the hostname means it is not a public domain.
   */
  publicWebUrl(path: string): URL {
    let base = (this.config.get<string>("app.appUrl") ?? "").trim();
    if (base && !/^https?:\/\//i.test(base)) base = `https://${base}`;
    try {
      const u = new URL(`${base.replace(/\/$/, "")}${path}`);
      if (!u.hostname.includes(".")) throw new Error("not a public host");
      return u;
    } catch {
      return new URL(`https://www.orderhubsolutions.com${path}`);
    }
  }

  private readInvite(token: string): InvitePayload {
    let decoded: InvitePayload;
    try {
      decoded = this.jwt.verify<InvitePayload>(token);
    } catch {
      throw new BadRequestException(
        "This link has expired or is no longer valid. Please ask for a new one.",
      );
    }
    if (decoded?.purpose !== "ubereats_invite") {
      throw new BadRequestException(
        "This link has expired or is no longer valid. Please ask for a new one.",
      );
    }
    return decoded;
  }

  /**
   * What the owner sees before they commit: whose shop this is, so nobody
   * signs into Uber without knowing what they are attaching it to.
   */
  async describeInvite(token: string): Promise<{
    brandName: string | null;
    locationName: string | null;
    alreadyConnected: boolean;
  }> {
    const invite = this.readInvite(token);
    const [brand, location, connection] = await Promise.all([
      (this.prisma as any).brand.findFirst({
        where: { id: invite.b },
        select: { name: true },
      }),
      (this.prisma as any).location.findFirst({
        where: { id: invite.l },
        select: { name: true },
      }),
      this.prisma.brandPlatformConnection.findFirst({
        where: {
          brandId: invite.b,
          locationId: invite.l,
          platform: "UBER_EATS",
        },
        select: { status: true },
      }),
    ]);
    return {
      brandName: brand?.name ?? null,
      locationName: location?.name ?? null,
      alreadyConnected: connection?.status === "connected",
    };
  }

  /**
   * The owner has pressed the button. Hand back an ordinary authorize URL —
   * the state it carries is the same shape the dashboard flow mints, so the
   * callback needs no knowledge that an invite was involved.
   */
  async startInvite(token: string): Promise<{ authorizeUrl: string }> {
    const invite = this.readInvite(token);
    const connection = await this.prisma.brandPlatformConnection.findFirst({
      where: {
        brandId: invite.b,
        locationId: invite.l,
        platform: "UBER_EATS",
      },
      select: { status: true },
    });
    if (connection?.status === "connected") {
      throw new BadRequestException(
        "This shop is already connected to Uber Eats. If you need to change " +
          "the account, please ask for a new link.",
      );
    }
    return {
      authorizeUrl: this.buildAuthorizeUrl({
        tenantId: invite.t,
        // No dashboard user behind an owner-initiated connect.
        userId: "invite",
        brandId: invite.b,
        locationId: invite.l,
      }),
    };
  }

  /**
   * OAuth callback: verify state, exchange the code, persist the merchant
   * token (encrypted) on a pending UBER_EATS connection row. Store selection
   * + pos_data provisioning happen next from the dashboard (UE-2).
   */
  async handleCallback(args: { code: string; state: string }) {
    let decoded: StatePayload;
    try {
      decoded = this.jwt.verify<StatePayload>(args.state);
      if (decoded.purpose !== "ubereats_oauth") throw new Error("bad purpose");
    } catch {
      throw new BadRequestException(
        "OAuth state has expired or is invalid. Start the connect flow again.",
      );
    }

    const token = await this.client.exchangeAuthorizationCode(
      args.code,
      this.redirectUri,
    );
    if (!token?.access_token) {
      throw new BadRequestException(
        "Uber Eats token exchange did not return an access_token.",
      );
    }

    // Prisma's InputJsonValue rejects Record<string, unknown> — the envelope
    // is plain JSON (string fields only) so the assertion is safe.
    const envelope = this.credentials.encrypt({
      merchantAccessToken: token.access_token,
      merchantRefreshToken: token.refresh_token ?? "",
      merchantTokenExpiresAt: new Date(
        Date.now() + (token.expires_in ?? 2_592_000) * 1000,
      ).toISOString(),
      scope: token.scope ?? "eats.pos_provisioning",
    });

    await this.prisma.brandPlatformConnection.upsert({
      where: {
        brandId_locationId_platform: {
          brandId: decoded.b,
          locationId: decoded.l,
          platform: "UBER_EATS",
        },
      },
      create: {
        tenantId: decoded.t,
        brandId: decoded.b,
        locationId: decoded.l,
        platform: "UBER_EATS",
        status: "pending", // connected once a store is provisioned
        metadata: { credentials: envelope } as Prisma.InputJsonValue,
      },
      update: {
        status: "pending",
        lastError: null,
        metadata: { credentials: envelope } as Prisma.InputJsonValue,
      },
    });

    this.logger.log(
      `Uber Eats merchant token stored for brand=${decoded.b} location=${decoded.l} (expires_in=${token.expires_in ?? "?"}s)`,
    );
    return { tenantId: decoded.t, brandId: decoded.b, locationId: decoded.l };
  }

  /** Decrypted merchant access token for a connection (throws if absent). */
  async merchantToken(connection: {
    metadata: unknown;
  }): Promise<string> {
    const meta = (connection.metadata ?? {}) as Record<string, any>;
    if (!meta.credentials) {
      throw new BadRequestException(
        "Uber Eats isn't authorised yet — run Connect Uber Eats first.",
      );
    }
    const decrypted = this.credentials.decrypt(
      meta.credentials as Record<string, unknown>,
    ) as Record<string, string>;
    const token = decrypted.merchantAccessToken;
    if (!token) {
      throw new BadRequestException(
        "Stored Uber Eats credentials are incomplete — reconnect Uber Eats.",
      );
    }
    const exp = Date.parse(decrypted.merchantTokenExpiresAt ?? "");
    if (Number.isFinite(exp) && exp < Date.now()) {
      throw new BadRequestException(
        "The Uber Eats authorisation has expired (30-day token) — reconnect Uber Eats.",
      );
    }
    return token;
  }
}
