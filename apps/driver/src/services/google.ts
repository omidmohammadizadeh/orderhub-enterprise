// Native Google Sign-In — same as the POS app. Note: the driver app uses a
// different bundle id, so Google sign-in needs its own iOS + Android OAuth
// clients before it works on device. Email/password login works regardless.

import { GoogleSignin, statusCodes } from "@react-native-google-signin/google-signin";
import Constants from "expo-constants";

const WEB_CLIENT_ID = Constants.expoConfig?.extra?.googleWebClientId as string | undefined;
const IOS_CLIENT_ID = Constants.expoConfig?.extra?.googleIosClientId as string | undefined;

export function configureGoogleSignIn() {
  if (!WEB_CLIENT_ID) return;
  GoogleSignin.configure({
    webClientId: WEB_CLIENT_ID,
    iosClientId: IOS_CLIENT_ID,
    offlineAccess: false,
  });
}

export async function signInWithGoogle(): Promise<string | null> {
  try {
    await GoogleSignin.hasPlayServices({ showPlayServicesUpdateDialog: true });
    const userInfo = await GoogleSignin.signIn();
    const idToken = userInfo?.data?.idToken;
    if (!idToken) throw new Error("Google sign-in returned no ID token");
    return idToken;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (err: any) {
    if (err?.code === statusCodes.SIGN_IN_CANCELLED) return null;
    throw err;
  }
}
