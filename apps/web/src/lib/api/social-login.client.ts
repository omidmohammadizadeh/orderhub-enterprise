// Admin → Social login. Which sign-in buttons each restaurant app shows:
// Apple + Google on iOS, Google on Android. Platform-admin only.

import { apiClient } from "./client";

export interface SocialLoginFlags {
  ios: { apple: boolean; google: boolean };
  android: { google: boolean };
}

export interface CustomerAppStore {
  promote: boolean;
  androidPackage: string | null;
  iosAppStoreId: string | null;
  /** Extra shops the brand's app sells from ("Shops in this app"). */
  shopIds: string[];
}

export interface BrandShopOption {
  id: string;
  name: string;
  postcode: string | null;
  isActive: boolean;
  /** Always in the app: the brand's own shop or its primary shop. */
  fixed: boolean;
  linked: boolean;
}

export interface IosOnboarding {
  contactEmail: string | null;
  teamId: string | null;
  keyId: string | null;
  issuerId: string | null;
  steps: {
    enrolled: boolean;
    keyReceived: boolean;
    appRecordCreated: boolean;
    built: boolean;
    submitted: boolean;
    live: boolean;
  };
  notes: string | null;
}

export interface SocialLoginAdminRow extends SocialLoginFlags {
  brandId: string;
  brandName: string;
  tenantName: string;
  logoUrl: string | null;
  /** Bundle ids of this brand's apps seen registering for push. */
  appIds: string[];
  store: CustomerAppStore;
  iosOnboarding: IosOnboarding;
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

  shops: (brandId: string) =>
    apiClient.get<BrandShopOption[]>(`/v1/admin/social-login/${brandId}/shops`).then((r) => r.data),

  setStore: (brandId: string, store: CustomerAppStore) =>
    apiClient.put<SocialLoginAdminRow>(`/v1/admin/social-login/${brandId}/store`, store).then((r) => r.data),

  setIosOnboarding: (brandId: string, onboarding: IosOnboarding) =>
    apiClient
      .put<SocialLoginAdminRow>(`/v1/admin/social-login/${brandId}/ios-onboarding`, onboarding)
      .then((r) => r.data),
};
