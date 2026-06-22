// Order Hub Solutions — POS mobile app
//
// Lean architecture: native auth (Google / Apple / email-password) +
// JWT injection + WebView around the existing /pos dashboard. Web POS
// owns rendering and business logic; the native layer just handles
// login, secure token storage, and keeps the screen alive so sound
// from the WebView's HTML5 Audio keeps firing while the tablet is
// on the counter.
//
// No FCM, no push, no native screens. Add those later only if needed.

import React, { useEffect, useState } from "react";
import { StatusBar } from "expo-status-bar";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { activateKeepAwakeAsync } from "expo-keep-awake";
import * as ScreenOrientation from "expo-screen-orientation";

import { LoginScreen } from "@/screens/LoginScreen";
import { PosWebView } from "@/screens/PosWebView";
import { LoadingScreen } from "@/screens/LoadingScreen";
import { useAuth } from "@/services/auth";
import { configureGoogleSignIn } from "@/services/google";

export default function App() {
  const { tokens, hydrated, setTokens } = useAuth();
  const [bootstrapped, setBootstrapped] = useState(false);

  useEffect(() => {
    (async () => {
      // Keep the till screen on while the app is foregrounded.
      await activateKeepAwakeAsync();
      // Tablet POS expects landscape. Phones can rotate freely; tablets
      // get pinned by the OS via app.json supportsTablet config.
      await ScreenOrientation.unlockAsync();
      configureGoogleSignIn();
      setBootstrapped(true);
    })().catch((err) => {
      // eslint-disable-next-line no-console
      console.warn("Bootstrap error", err);
      setBootstrapped(true);
    });
  }, []);

  if (!hydrated || !bootstrapped) {
    return (
      <SafeAreaProvider>
        <StatusBar style="light" />
        <LoadingScreen />
      </SafeAreaProvider>
    );
  }

  return (
    <SafeAreaProvider>
      <StatusBar style="light" />
      {tokens ? (
        <PosWebView tokens={tokens} onSignOut={() => setTokens(null)} />
      ) : (
        <LoginScreen onSignedIn={(t) => setTokens(t)} />
      )}
    </SafeAreaProvider>
  );
}
