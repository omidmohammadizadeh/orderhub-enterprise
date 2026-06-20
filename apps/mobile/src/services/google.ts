// Native Google Sign-In — renders Google's real account-picker sheet,
// returns an ID token we exchange for an OrderHub JWT.

import {
  GoogleSignin,
  statusCodes,
} from "@react-native-google-signin/google-signin";
import Constants from "expo-constants";

const WEB_CLIENT_ID = Constants.expoConfig?.extra?.googleWebClientId as
  | string
  | undefined;
const IOS_CLIENT_ID = Constants.expoConfig?.extra?.googleIosClientId as
  | string
  | undefined;

export function configureGoogleSignIn() {
  if (!WEB_CLIENT_ID) {
    // eslint-disable-next-line no-console
    console.warn("googleWebClientId missing from app.json extra");
    return;
  }
  GoogleSignin.configure({
    webClientId: WEB_CLIENT_ID,
    iosClientId: IOS_CLIENT_ID,
    offlineAccess: false,
    forceCodeForRefreshToken: false,
  });
}

export async function signInWithGoogle(): Promise<string | null> {
  try {
    await GoogleSignin.hasPlayServices({ showPlayServicesUpdateDialog: true });
    const userInfo = await GoogleSignin.signIn();
    const idToken = userInfo?.data?.idToken;
    if (!idToken) {
      throw new Error("Google sign-in returned no ID token");
    }
    return idToken;
  } catch (err: any) {
    if (err?.code === statusCodes.SIGN_IN_CANCELLED) return null;
    throw err;
  }
}

export async function signOutGoogle() {
  try {
    await GoogleSignin.signOut();
  } catch {
    // Best effort.
  }
}
