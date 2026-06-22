// PosWebView — the full-screen native shell around the existing web POS.
//
// Three things make this feel native instead of "just a browser":
//   1. The JWT pair is handed off via /auth/oauth/callback?access=…&refresh=…
//      — that page already exists for the web's Google OAuth flow and
//      populates the Zustand auth store (`orderhub-auth`) the right way,
//      then redirects to /dashboard. We can't just localStorage.setItem
//      directly: the web persists a wrapped Zustand shape with user +
//      isAuthenticated flags, not a bare token.
//   2. mediaPlaybackRequiresUserAction={false} +
//      allowsInlineMediaPlayback so the web POS can play its order
//      sound via HTML5 Audio without a tap-to-unlock.
//   3. A small JS bridge listens for { type: "signout" } messages from
//      the web (so the web logout button drops us back to LoginScreen)
//      and for { type: "openExternal", url } (so external links open
//      in the system browser, not inside the WebView).

import React, { useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  RefreshControl,
  ScrollView,
  StyleSheet,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { WebView, WebViewMessageEvent } from "react-native-webview";
import * as Linking from "expo-linking";
import Constants from "expo-constants";

import { signOutGoogle } from "@/services/google";
import type { AuthTokens } from "@/services/auth";

const WEB_URL =
  (Constants.expoConfig?.extra?.webUrl as string | undefined) ??
  "https://orderhubsolutions.com";

interface Props {
  tokens: AuthTokens;
  onSignOut: () => void;
}

export function PosWebView({ tokens, onSignOut }: Props) {
  const webRef = useRef<WebView>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [loaded, setLoaded] = useState(false);

  // Hand both tokens to the web via its existing OAuth-callback page —
  // that page sets the Zustand store + fetches /me, then router.replace
  // to /dashboard. Far more reliable than guessing the persist shape.
  const handoffUrl = useMemo(() => {
    const qs = new URLSearchParams({
      access: tokens.accessToken,
      refresh: tokens.refreshToken,
    });
    return `${WEB_URL}/auth/oauth/callback?${qs.toString()}`;
  }, [tokens]);

  // Tiny native ↔ web bridge for sign-out + external link opens.
  // The token handoff happens via the URL above, not via injection.
  const injectedBeforeLoad = useMemo(
    () => `
      (function () {
        window.OrderHubNative = {
          signOut: function () {
            window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'signout' }));
          },
          openExternal: function (url) {
            window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'openExternal', url: url }));
          }
        };
        true;
      })();
    `,
    [],
  );

  const onMessage = async (e: WebViewMessageEvent) => {
    try {
      const msg = JSON.parse(e.nativeEvent.data);
      if (msg?.type === "signout") {
        await signOutGoogle();
        onSignOut();
      } else if (msg?.type === "openExternal" && msg?.url) {
        await Linking.openURL(String(msg.url));
      }
    } catch {
      // Ignore non-JSON / non-OrderHub messages.
    }
  };

  // The web's logout button just clears its Zustand store and redirects
  // to /login. The web has no idea it's running inside a native shell,
  // so it never calls window.OrderHubNative.signOut(). We watch the
  // WebView's URL: anytime it ends up on the dashboard /login page,
  // treat that as a logout and bounce back to the native LoginScreen.
  const handleNavStateChange = async (state: { url: string }) => {
    const u = state.url || "";
    // Match /login (with or without query string) but NOT
    // /auth/oauth/callback (that one is the handoff URL we load on
    // sign-in) and NOT the storefront /order/[slug]/login (customer auth).
    const isDashboardLogin =
      /\/login(\?|$|#)/.test(u) && !u.includes("/order/");
    if (isDashboardLogin) {
      await signOutGoogle();
      onSignOut();
    }
  };

  return (
    <SafeAreaView style={styles.container} edges={["top", "bottom"]}>
      <ScrollView
        style={styles.flex}
        contentContainerStyle={styles.flex}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => {
              setRefreshing(true);
              webRef.current?.reload();
              setTimeout(() => setRefreshing(false), 1200);
            }}
            tintColor="#F97316"
          />
        }
      >
        <WebView
          ref={webRef}
          source={{ uri: handoffUrl }}
          injectedJavaScriptBeforeContentLoaded={injectedBeforeLoad}
          onMessage={onMessage}
          onNavigationStateChange={handleNavStateChange}
          onLoadEnd={() => setLoaded(true)}
          // Sound + media autoplay — the existing web POS plays an MP3
          // when a new order lands; without these flags WKWebView blocks
          // it until a user tap.
          mediaPlaybackRequiresUserAction={false}
          allowsInlineMediaPlayback
          // Cookies + localStorage persist across launches so the web
          // session survives a cold start (in addition to our JWT).
          sharedCookiesEnabled
          domStorageEnabled
          // The web app uses fetch/XHR everywhere; we don't need file
          // upload via input[type=file] for v1 (image uploads happen
          // from the dashboard on desktop) — flip this on later if we
          // want camera capture from the tablet.
          allowFileAccess={false}
          // Pull-to-refresh + system back button feel native this way.
          pullToRefreshEnabled
          // If the web POS is paused on a backgrounded tab, the OS may
          // throttle JS; this keeps the timer/poll loops alive.
          androidLayerType="hardware"
          startInLoadingState
          renderLoading={() => (
            <View style={styles.loadingOverlay}>
              <ActivityIndicator size="large" color="#F97316" />
            </View>
          )}
          style={styles.flex}
        />
        {!loaded && (
          <View pointerEvents="none" style={styles.loadingOverlay}>
            <ActivityIndicator size="large" color="#F97316" />
          </View>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#0F172A" },
  flex: { flex: 1 },
  loadingOverlay: {
    ...StyleSheet.absoluteFillObject,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#0F172A",
  },
});
