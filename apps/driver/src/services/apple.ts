// Native Sign in with Apple — iOS only. Returns the identity token for the API.

import * as AppleAuthentication from "expo-apple-authentication";
import { Platform } from "react-native";

export async function isAppleSignInAvailable(): Promise<boolean> {
  if (Platform.OS !== "ios") return false;
  return AppleAuthentication.isAvailableAsync();
}

export interface AppleSignInResult {
  idToken: string;
  email: string | null;
  fullName: { givenName: string | null; familyName: string | null };
}

export async function signInWithApple(): Promise<AppleSignInResult | null> {
  try {
    const credential = await AppleAuthentication.signInAsync({
      requestedScopes: [
        AppleAuthentication.AppleAuthenticationScope.FULL_NAME,
        AppleAuthentication.AppleAuthenticationScope.EMAIL,
      ],
    });
    if (!credential.identityToken) throw new Error("Apple sign-in returned no identity token");
    return {
      idToken: credential.identityToken,
      email: credential.email ?? null,
      fullName: {
        givenName: credential.fullName?.givenName ?? null,
        familyName: credential.fullName?.familyName ?? null,
      },
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (err: any) {
    if (err?.code === "ERR_REQUEST_CANCELED") return null;
    throw err;
  }
}
