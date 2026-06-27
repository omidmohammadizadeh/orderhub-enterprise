import {
  Injectable,
  Logger,
  UnauthorizedException,
  ServiceUnavailableException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { OAuth2Client } from "google-auth-library";
import { createRemoteJWKSet, jwtVerify } from "jose";
import type { OAuthProfile } from "../interfaces/oauth-provider.interface";

// NativeOAuthService verifies ID tokens that come from native mobile
// SDKs (Google Sign-In on iOS/Android, Sign in with Apple on iOS) and
// returns a normalised OAuthProfile that the OAuthService can consume.
//
// Why a separate service:
// - The Passport-based Google strategy used by the web does a server-side
//   code-exchange dance, which doesn't make sense for mobile (the mobile
//   SDK already has a verified ID token).
// - Apple has no Passport strategy here; the mobile SDK is the only path
//   we support, and verification is just JWT validation against Apple's
//   published JWKS.

@Injectable()
export class NativeOAuthService {
  private readonly logger = new Logger(NativeOAuthService.name);

  // Apple's signing keys, fetched and cached by `jose`. The remote set
  // refreshes itself when an unknown `kid` is encountered.
  private readonly appleJwks = createRemoteJWKSet(
    new URL("https://appleid.apple.com/auth/keys"),
  );

  constructor(private readonly config: ConfigService) {}

  // ── Google ──────────────────────────────────────────────────────────
  //
  // Mobile sends the `idToken` returned by @react-native-google-signin/google-signin.
  // We verify against the set of valid audiences (iOS client ID + Web client ID;
  // Android sign-in uses the Web client ID as its audience, by design).
  async verifyGoogleIdToken(idToken: string): Promise<OAuthProfile> {
    const audiences = [
      this.config.get<string>("GOOGLE_IOS_CLIENT_ID"),
      this.config.get<string>("GOOGLE_CLIENT_ID"), // Web client ID
    ].filter((v): v is string => !!v && v.length > 0);

    if (audiences.length === 0) {
      throw new ServiceUnavailableException(
        "Google native sign-in is not configured. Set GOOGLE_CLIENT_ID (web) and/or GOOGLE_IOS_CLIENT_ID on the API.",
      );
    }

    const client = new OAuth2Client();
    let payload;
    try {
      const ticket = await client.verifyIdToken({
        idToken,
        audience: audiences,
      });
      payload = ticket.getPayload();
    } catch (err: any) {
      this.logger.warn(`Google ID token verification failed: ${err?.message}`);
      throw new UnauthorizedException("Invalid Google ID token");
    }

    if (!payload || !payload.sub || !payload.email) {
      throw new UnauthorizedException(
        "Google ID token missing required claims",
      );
    }

    return {
      provider: "GOOGLE",
      providerAccountId: payload.sub,
      email: payload.email,
      emailVerified: payload.email_verified === true,
      firstName: payload.given_name ?? "",
      lastName: payload.family_name ?? "",
      avatarUrl: payload.picture,
      idToken,
    };
  }

  // ── Apple ───────────────────────────────────────────────────────────
  //
  // Apple identity tokens are signed JWTs (ES256). We verify against Apple's
  // published JWKS, then enforce issuer and audience claims ourselves.
  // The audience must equal the iOS bundle ID — we use the same one as the
  // Expo app: com.orderhubsolutions.pos (configurable via APPLE_BUNDLE_ID).
  //
  // Apple only returns `name` and `email` on the FIRST authorisation per
  // Apple ID, so mobile passes those through as a fallback when present.
  async verifyAppleIdToken(
    idToken: string,
    fallbackEmail?: string | null,
    fallbackFullName?: { givenName?: string | null; familyName?: string | null },
  ): Promise<OAuthProfile> {
    // APPLE_BUNDLE_ID may be a comma-separated list so multiple native apps
    // (e.g. the POS app + the driver app, each with its own bundle id) all
    // validate against the same API.
    const audiences = (this.config.get<string>("APPLE_BUNDLE_ID") ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (audiences.length === 0) {
      throw new ServiceUnavailableException(
        "Apple sign-in is not configured. Set APPLE_BUNDLE_ID on the API (e.g. com.orderhubsolutions.pos,com.orderhubsolutions.driver).",
      );
    }

    let payload: Record<string, unknown>;
    try {
      const verified = await jwtVerify(idToken, this.appleJwks, {
        issuer: "https://appleid.apple.com",
        audience: audiences,
      });
      payload = verified.payload as Record<string, unknown>;
    } catch (err: any) {
      this.logger.warn(`Apple ID token verification failed: ${err?.message}`);
      throw new UnauthorizedException("Invalid Apple ID token");
    }

    const sub = payload["sub"] as string | undefined;
    if (!sub) {
      throw new UnauthorizedException(
        "Apple ID token missing subject claim",
      );
    }

    // Apple either embeds `email` in the JWT (first-time sign-in or when
    // sharing a real address) or omits it (when "Hide My Email" relay is
    // used after the first sign-in). The relay address is also stable per
    // app, so it works as our user email going forward.
    const email =
      (payload["email"] as string | undefined) ??
      fallbackEmail ??
      `${sub}@privaterelay.appleid.com`;

    const emailVerified =
      payload["email_verified"] === true || payload["email_verified"] === "true";

    return {
      provider: "APPLE",
      providerAccountId: sub,
      email,
      emailVerified,
      firstName: fallbackFullName?.givenName ?? "",
      lastName: fallbackFullName?.familyName ?? "",
      idToken,
    };
  }
}
