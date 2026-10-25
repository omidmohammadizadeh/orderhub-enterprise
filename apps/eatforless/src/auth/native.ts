// Native Sign in with Apple and Google. Each returns the provider's ID token,
// which /customer-auth/native exchanges for an Eat For Less session.
//
// Server side, the API only accepts tokens minted for audiences it knows:
// com.eatforless.app must be in CUSTOMER_APP_APPLE_BUNDLE_IDS, and the Google
// clients in CUSTOMER_APP_GOOGLE_CLIENT_IDS (Render env, not code).

import * as AppleAuthentication from "expo-apple-authentication";
import { Platform } from "react-native";
import { GOOGLE_IOS_CLIENT_ID, GOOGLE_WEB_CLIENT_ID, MOCK } from "@/config";

export async function isAppleSignInAvailable(): Promise<boolean> {
  if (Platform.OS !== "ios") return false;
  return AppleAuthentication.isAvailableAsync().catch(() => false);
}

export type NativeToken = { idToken: string; firstName?: string; lastName?: string };

export async function appleIdToken(): Promise<NativeToken | null> {
  try {
    const credential = await AppleAuthentication.signInAsync({
      requestedScopes: [
        AppleAuthentication.AppleAuthenticationScope.FULL_NAME,
        AppleAuthentication.AppleAuthenticationScope.EMAIL,
      ],
    });
    if (!credential.identityToken) throw new Error("Apple didn't return a sign-in token. Please try again.");
    // Apple gives the name on the FIRST sign-in only, and never in the token.
    return {
      idToken: credential.identityToken,
      firstName: credential.fullName?.givenName ?? undefined,
      lastName: credential.fullName?.familyName ?? undefined,
    };
  } catch (err: any) {
    if (err?.code === "ERR_REQUEST_CANCELED") return null;
    throw err;
  }
}

/** Google needs OAuth clients for com.eatforless.app, which don't exist yet. */
export const googleConfigured = !!GOOGLE_WEB_CLIENT_ID && (Platform.OS !== "ios" || !!GOOGLE_IOS_CLIENT_ID);

let googleReady = false;

export async function googleIdToken(): Promise<NativeToken | null> {
  if (!googleConfigured) {
    throw new Error("Google sign-in is coming soon. Please use Apple or email for now.");
  }
  // Loaded lazily: the module is only linked once its plugin is configured.
  const { GoogleSignin, statusCodes } = require("@react-native-google-signin/google-signin");
  if (!googleReady) {
    GoogleSignin.configure({ webClientId: GOOGLE_WEB_CLIENT_ID, iosClientId: GOOGLE_IOS_CLIENT_ID || undefined });
    googleReady = true;
  }
  try {
    await GoogleSignin.hasPlayServices({ showPlayServicesUpdateDialog: true });
    const res = await GoogleSignin.signIn();
    const idToken = res?.data?.idToken;
    if (!idToken) throw new Error("Google didn't return a sign-in token. Please try again.");
    return { idToken };
  } catch (err: any) {
    if (err?.code === statusCodes.SIGN_IN_CANCELLED) return null;
    throw err;
  }
}

/** In sample-data mode the providers are skipped entirely. */
export const nativeSignInSkipped = MOCK;
