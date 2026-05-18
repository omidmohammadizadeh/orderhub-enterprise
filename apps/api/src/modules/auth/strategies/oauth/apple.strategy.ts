import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { OAuthBaseStrategy } from "./oauth-base.strategy";
import { OAuthService } from "../../services/oauth.service";
import { TokenService } from "../../services/token.service";
import { PrismaService } from "../../../../infrastructure/database/prisma.service";
import type { OAuthProfile } from "../../interfaces/oauth-provider.interface";

// ─────────────────────────────────────────────────────────
// Apple Sign In strategy — ARCHITECTURE PREPARED, not wired to Passport yet.
//
// Apple Sign In requires:
//   1. Apple Developer account with "Sign in with Apple" capability
//   2. Service ID (client_id) + Team ID + Key ID + private key (.p8 file)
//   3. The apple-signin-auth library (not passport-apple — it's better maintained)
//
// Apple has two quirks different from standard OAuth:
//   a. User profile (name, email) is only sent on the FIRST authorisation.
//      After that Apple sends nothing. You must save it on first login.
//   b. The id_token is a JWT from Apple's public keys — verify it client-side
//      and parse claims yourself (no userinfo endpoint).
//
// To activate:
//   1. `pnpm add apple-signin-auth` in apps/api
//   2. Set APPLE_TEAM_ID, APPLE_CLIENT_ID, APPLE_KEY_ID, APPLE_PRIVATE_KEY
//   3. Uncomment the Passport registration in AuthModule
//   4. Add the route in AuthController
// ─────────────────────────────────────────────────────────
@Injectable()
export class AppleStrategy extends OAuthBaseStrategy {
  readonly provider = "APPLE" as const;
  private readonly logger = new Logger(AppleStrategy.name);

  constructor(
    config: ConfigService,
    oauthService: OAuthService,
    tokenService: TokenService,
    prisma: PrismaService,
  ) {
    super(oauthService, tokenService, prisma);
    // Config validation — fail fast at startup if keys are missing
    const required = [
      "APPLE_TEAM_ID",
      "APPLE_CLIENT_ID",
      "APPLE_KEY_ID",
      "APPLE_PRIVATE_KEY",
    ];
    const missing = required.filter((k) => !config.get(k));
    if (missing.length > 0) {
      this.logger.warn(
        `Apple Sign In not configured. Missing: ${missing.join(", ")}. ` +
          `The strategy is registered but the route will return 501 until configured.`,
      );
    }
  }

  // Apple sends a JWT (id_token) in the callback body.
  // We decode + verify it here and extract the user claims.
  async translate(
    _accessToken: string,
    _refreshToken: string | undefined,
    rawProfile: unknown,
  ): Promise<OAuthProfile> {
    // TODO: integrate apple-signin-auth here when activating
    // const appleSignin = await import("apple-signin-auth");
    // const payload = await appleSignin.verifyIdToken(rawProfile.id_token, {
    //   audience: process.env.APPLE_CLIENT_ID,
    //   ignoreExpiration: false,
    // });
    // return { provider: "APPLE", providerAccountId: payload.sub, ... };

    throw new Error("Apple Sign In: translate() not implemented yet — see comments");
  }
}
