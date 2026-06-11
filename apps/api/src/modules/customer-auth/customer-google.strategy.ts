// Phase AP-AUTH increment 2b — Google OAuth for customer-facing storefront.
//
// Distinct from the staff GoogleStrategy via:
//   * Passport name           "customer-google"
//   * Callback URL             /api/v1/customer-auth/google/callback
//   * Identity model           CustomerAccount, not User
//
// We deliberately reuse the same GOOGLE_CLIENT_ID + GOOGLE_CLIENT_SECRET
// as staff auth. One Google project, one consent screen, one set of
// brand assets to maintain. Inside Google Cloud Console the operator
// adds BOTH redirect URIs to the same OAuth client's allow-list:
//
//   https://orderhub-api-0re6.onrender.com/api/v1/auth/oauth/google/callback   (staff)
//   https://orderhub-api-0re6.onrender.com/api/v1/customer-auth/google/callback (customer)
//
// The `state` query param threads through the operator's storefront
// slug — Google bounces it back unchanged so the callback handler
// knows which storefront to redirect the customer to after sign-in.

import { Injectable, Logger } from "@nestjs/common";
import { PassportStrategy } from "@nestjs/passport";
import { Strategy, Profile, VerifyCallback } from "passport-google-oauth20";
import { ConfigService } from "@nestjs/config";

export interface CustomerGoogleProfile {
  googleId: string;
  email: string;
  firstName: string;
  lastName: string;
  avatarUrl?: string;
}

@Injectable()
export class CustomerGoogleStrategy extends PassportStrategy(
  Strategy,
  "customer-google",
) {
  private readonly logger = new Logger(CustomerGoogleStrategy.name);

  constructor(config: ConfigService) {
    const clientID = config.get("GOOGLE_CLIENT_ID", "");
    const clientSecret = config.get("GOOGLE_CLIENT_SECRET", "");
    const configured = !!clientID && !!clientSecret;
    const apiUrl = config.get("API_URL", "http://localhost:4000");
    super({
      clientID: clientID || "GOOGLE_NOT_CONFIGURED",
      clientSecret: clientSecret || "GOOGLE_NOT_CONFIGURED",
      callbackURL: `${apiUrl}/api/v1/customer-auth/google/callback`,
      scope: ["email", "profile"],
      // Customers re-pick accounts often (shared devices, multi-account
      // households), so we always show the account chooser.
      prompt: "select_account",
      // Pass `state` from the initial request through to the callback —
      // we use it to know which storefront slug to redirect back to.
      passReqToCallback: false,
    });
    if (!configured) {
      this.logger.warn(
        "Customer Google OAuth not configured (GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET missing). Routes return 501 until set.",
      );
    }
  }

  async validate(
    _accessToken: string,
    _refreshToken: string,
    profile: Profile,
    done: VerifyCallback,
  ): Promise<void> {
    const email = profile.emails?.[0]?.value;
    if (!email) {
      return done(new Error("Google profile is missing email"), false);
    }
    // email.split("@")[0] technically returns string|undefined under
    // noUncheckedIndexedAccess; the regex above guarantees a value but
    // TS doesn't follow that. Default safely.
    const firstNameFallback = email.split("@")[0] ?? "Friend";
    const customerProfile: CustomerGoogleProfile = {
      googleId: profile.id,
      email,
      firstName: profile.name?.givenName ?? firstNameFallback,
      lastName: profile.name?.familyName ?? "",
      avatarUrl: profile.photos?.[0]?.value,
    };
    return done(null, customerProfile);
  }
}
