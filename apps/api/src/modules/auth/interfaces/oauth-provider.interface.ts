import type { OAuthProvider } from "@orderhub/database";

// The normalised profile shape every OAuth strategy must produce.
// Strategies translate provider-specific responses (Google profile, Apple JWT, etc.)
// into this canonical form before the OAuthService touches it.
export interface OAuthProfile {
  provider: OAuthProvider;
  providerAccountId: string; // Stable, unique ID on the provider
  email: string;
  emailVerified: boolean;
  firstName: string;
  lastName: string;
  avatarUrl?: string;
  // Raw tokens — encrypted before DB storage
  accessToken?: string;
  refreshToken?: string;
  expiresAt?: Date;
  scope?: string;
  idToken?: string;
}

// Contract that every OAuth strategy adapter must implement.
// The OAuthService calls these methods generically — no strategy-specific
// code leaks into the service layer.
export interface IOAuthStrategy {
  readonly provider: OAuthProvider;
  validate(accessToken: string, refreshToken: string, profile: unknown): Promise<OAuthProfile>;
}

// What comes back from the OAuth callback — used by the controller
// to issue our own JWT pair after OAuth succeeds.
export interface OAuthCallbackResult {
  userId: string;
  tenantId: string;
  isNewUser: boolean;
}
