import { Injectable, Logger } from "@nestjs/common";
import { PassportStrategy } from "@nestjs/passport";
import { Strategy, Profile, VerifyCallback } from "passport-google-oauth20";
import { ConfigService } from "@nestjs/config";
import { OAuthBaseStrategy } from "./oauth-base.strategy";
import { OAuthService } from "../../services/oauth.service";
import { TokenService } from "../../services/token.service";
import { PrismaService } from "../../../../infrastructure/database/prisma.service";
import type { OAuthProfile } from "../../interfaces/oauth-provider.interface";

// Google OAuth 2.0 strategy.
// Scopes: profile + email are sufficient for authentication.
// We do NOT request calendar, drive, etc. — least-privilege principle.
//
// To activate: set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in .env.
// Register callback URL in Google Cloud Console:
//   https://your-domain.com/api/v1/auth/oauth/google/callback
@Injectable()
export class GoogleStrategy
  extends PassportStrategy(Strategy, "google")
  implements Pick<OAuthBaseStrategy, "translate">
{
  readonly provider = "GOOGLE" as const;
  private readonly logger = new Logger(GoogleStrategy.name);

  constructor(
    config: ConfigService,
    private readonly oauthService: OAuthService,
    private readonly tokenService: TokenService,
    private readonly prisma: PrismaService,
  ) {
    const clientID = config.get("GOOGLE_CLIENT_ID", "");
    const clientSecret = config.get("GOOGLE_CLIENT_SECRET", "");
    const configured = !!clientID && !!clientSecret;
    super({
      // Use placeholder when credentials are absent so Passport doesn't throw at startup.
      // Routes will return 501 until GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET are set.
      clientID: clientID || "GOOGLE_NOT_CONFIGURED",
      clientSecret: clientSecret || "GOOGLE_NOT_CONFIGURED",
      callbackURL: `${config.get("API_URL", "http://localhost:4000")}/api/v1/auth/oauth/google/callback`,
      scope: ["email", "profile"],
      accessType: "offline",
      prompt: "select_account",
    });
    if (!configured) {
      this.logger.warn(
        "Google OAuth not configured. Missing: GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET. " +
          "The strategy is registered but OAuth routes will not work until configured.",
      );
    }
  }

  // Passport calls validate() after the Google redirect. The return value
  // is attached to request.user and passed to the controller.
  async validate(
    accessToken: string,
    refreshToken: string,
    profile: Profile,
    done: VerifyCallback,
  ) {
    try {
      const oauthProfile = await this.translate(accessToken, refreshToken, profile);
      done(null, oauthProfile);
    } catch (err) {
      done(err as Error, undefined);
    }
  }

  async translate(
    accessToken: string,
    refreshToken: string | undefined,
    rawProfile: unknown,
  ): Promise<OAuthProfile> {
    const profile = rawProfile as Profile;
    const email = profile.emails?.[0]?.value;

    if (!email) {
      throw new Error("Google profile did not include an email address");
    }

    return {
      provider: "GOOGLE",
      providerAccountId: profile.id,
      email,
      emailVerified: !!profile.emails?.[0]?.verified,
      firstName: profile.name?.givenName ?? "",
      lastName: profile.name?.familyName ?? "",
      avatarUrl: profile.photos?.[0]?.value,
      accessToken,
      refreshToken,
    };
  }
}
