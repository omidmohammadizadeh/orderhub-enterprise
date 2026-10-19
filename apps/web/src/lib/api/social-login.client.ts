// Admin → Social login. Which sign-in buttons each restaurant app shows:
// Apple + Google on iOS, Google on Android. Platform-admin only.

import { apiClient } from "./client";

export interface SocialLoginFlags {
  ios: { apple: boolean; google: boolean };
  android: { google: boolean };
}

export interface SocialLoginAdminRow extends SocialLoginFlags {
  brandId: string;
  brandName: string;
  tenantName: string;
  logoUrl: string | null;
  /** Bundle ids of this brand's apps seen registering for push. */
  appIds: string[];
}

export const socialLoginClient = {
  list: () =>
    apiClient.get<SocialLoginAdminRow[]>("/v1/admin/social-login").then((r) => r.data),

  set: (brandId: string, flags: SocialLoginFlags) =>
    apiClient
      .put<SocialLoginAdminRow>(`/v1/admin/social-login/${brandId}`, {
        iosApple: flags.ios.apple,
        iosGoogle: flags.ios.google,
        androidGoogle: flags.android.google,
      })
      .then((r) => r.data),
};
