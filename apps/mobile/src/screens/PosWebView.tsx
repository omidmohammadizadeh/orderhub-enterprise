// PosWebView — the full-screen native shell around the existing web POS.
//
// Three things make this feel native instead of "just a browser":
//   1. On a FRESH native login only, the JWT pair is handed off via
//      /auth/oauth/callback?access=…&refresh=… — that page already exists
//      for the web's Google OAuth flow and populates the Zustand auth store
//      (`orderhub-auth`) the right way, then redirects to /dashboard. We
//      can't just localStorage.setItem directly: the web persists a wrapped
//      Zustand shape with user + isAuthenticated flags, not a bare token.
//      On an app RELAUNCH we load /dashboard directly instead and trust the
//      WebView's own persisted session (domStorage/cookies survive across
//      launches, see below) — re-running the handoff with the RN-held
//      snapshot would clobber whatever fresher refresh token the WebView's
//      own JS has since rotated to, since RN's copy is never updated after
//      the initial login. That clobber was a real bug: the stale token
//      later got presented as "reused", which the server treated as theft.
//   2. mediaPlaybackRequiresUserAction={false} +
//      allowsInlineMediaPlayback so the web POS can play its order
//      sound via HTML5 Audio without a tap-to-unlock.
//   3. A small JS bridge listens for { type: "signout" } messages from
//      the web (so the web logout button drops us back to LoginScreen)
//      and for { type: "openExternal", url } (so external links open
//      in the system browser, not inside the WebView).

import React, { useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { WebView, WebViewMessageEvent } from "react-native-webview";
import * as Linking from "expo-linking";
import Constants from "expo-constants";

import { signOutGoogle } from "@/services/google";
import type { AuthTokens } from "@/services/auth";
import {
  listBondedDevices,
  sendBytesOverBt,
  ensureBtPermissions,
} from "@/print/transport/bluetooth";
import { sendBytesOverTcp } from "@/print/transport/lan";
import { startCometReader, stopCometReader } from "@/callerid/comet";
import { terminalController } from "@/services/terminal";

// MUST be the canonical domain the site actually serves (www). Loading the
// non-www host triggers a redirect to www, and because the login handoff sets
// the web session in per-origin localStorage, the session set on the non-www
// origin is lost when the WebView follows the redirect to www → the web app
// sees no session and bounces to /login (the login-loop bug).
const WEB_URL =
  (Constants.expoConfig?.extra?.webUrl as string | undefined) ??
  "https://www.orderhubsolutions.com";

interface Props {
  tokens: AuthTokens;
  // True only immediately after a fresh native login (Google/Apple/email) —
  // the WebView has never seen this token pair, so it needs the handoff.
  // False on an app relaunch that hydrated from SecureStore: that snapshot
  // goes stale the moment the WebView's own JS rotates its refresh token
  // (which happens independently while the app is open), so re-injecting it
  // via the handoff would clobber the WebView's own further-rotated session
  // — the exact bug that caused a stale-token replay to nuke every session
  // for the user (fixed server-side too, but this is the actual root cause).
  fromFreshLogin: boolean;
  onSignOut: () => void;
}

export function PosWebView({ tokens, fromFreshLogin, onSignOut }: Props) {
  const webRef = useRef<WebView>(null);
  const [loaded, setLoaded] = useState(false);
  // Only the very first mount after a fresh login should use the handoff
  // URL. Capture it once so a later re-render (e.g. tokens object identity
  // changing for unrelated reasons) can't flip an already-loaded WebView
  // back to the handoff URL and re-clobber its session.
  const [useHandoff] = useState(fromFreshLogin);

  // TEMP on-screen diagnostic trail (login-loop debugging) — shows the WebView
  // navigation sequence so it can be screenshotted without Metro/adb. URLs are
  // shown as PATH ONLY (query stripped) so tokens are never displayed. Remove
  // once the login loop is fixed.
  const [dbg, setDbg] = useState<string[]>([]);
  const shortPath = (u: string): string => {
    try {
      const x = new URL(u);
      return x.pathname + (x.hash || "");
    } catch {
      return (u || "").split("?")[0];
    }
  };
  const pushDbg = (line: string) =>
    setDbg((d) => [...d.slice(-9), line]);

  // Caller-ID hub (Android only, no-ops elsewhere): read the CTI Comet USB
  // box on the shop's analogue line and hand every ring to the web app,
  // which POSTs /v1/customers/caller-id/ring with its own auth + selected
  // location — the API then broadcasts the popup to EVERY tablet.
  useEffect(() => {
    startCometReader(
      (phone, rawLine) => {
        webRef.current?.injectJavaScript(
          `window.dispatchEvent(new CustomEvent('native:callerid', { detail: ${JSON.stringify(
            { phone, rawLine },
          )} })); true;`,
        );
      },
      (msg) => console.log(msg),
    );
    return () => stopCometReader();
  }, []);

  // Hand both tokens to the web via its existing OAuth-callback page —
  // that page sets the Zustand store + fetches /me, then router.replace
  // to /dashboard. Far more reliable than guessing the persist shape.
  // Only used on a fresh login (see useHandoff above); a relaunch instead
  // loads the dashboard directly and trusts the WebView's own persisted
  // session (domStorage/cookies survive across launches — enabled below).
  const initialUrl = useMemo(() => {
    if (!useHandoff) return `${WEB_URL}/dashboard`;
    const qs = new URLSearchParams({
      access: tokens.accessToken,
      refresh: tokens.refreshToken,
    });
    return `${WEB_URL}/auth/oauth/callback?${qs.toString()}`;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [useHandoff]);

  useEffect(() => {
    pushDbg(`boot handoff=${useHandoff} → ${shortPath(initialUrl)}`);
    // eslint-disable-next-line no-console
    console.log("[OH boot] useHandoff=", useHandoff, "initialUrl=", initialUrl);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialUrl, useHandoff]);

  // Native ↔ web bridge.
  //
  // window.OrderHubNative — signOut + openExternal (existing).
  // window.OrderHubBT     — let the dashboard's Printers tab see the
  //                         tablet's paired BT devices and send raw
  //                         ESC/POS bytes to one of them. With this
  //                         the operator never has to open a separate
  //                         "printer setup" screen: pair the printer
  //                         in Android settings, open Printers tab,
  //                         pick the paired printer from a dropdown,
  //                         click save. Done.
  //
  // Request/response uses { type, reqId } envelopes; native sends the
  // result back by injecting `window.__ohbtResolve(reqId, value)`. The
  // bridge helpers return Promises that resolve / reject when that fires.
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

        var pending = {};
        var nextId = 1;
        function request(type, payload) {
          return new Promise(function (resolve, reject) {
            var reqId = 'r' + (nextId++);
            pending[reqId] = { resolve: resolve, reject: reject };
            window.ReactNativeWebView.postMessage(JSON.stringify({
              type: type, reqId: reqId, payload: payload || null
            }));
          });
        }
        window.__ohbtResolve = function (reqId, value) {
          var p = pending[reqId]; if (!p) return; delete pending[reqId];
          p.resolve(value);
        };
        window.__ohbtReject = function (reqId, msg) {
          var p = pending[reqId]; if (!p) return; delete pending[reqId];
          p.reject(new Error(msg || 'bridge error'));
        };

        window.OrderHubBT = {
          isReady: true,
          listDevices: function () { return request('bt:list'); },
          print: function (mac, base64Bytes) {
            return request('bt:print', { mac: mac, bytes: base64Bytes });
          },
          // LAN / network printer (raw TCP 9100). Same base64 byte
          // transport as Bluetooth — native opens a socket to ip:port,
          // writes the ESC/POS bytes, drains, and closes.
          printLan: function (ip, port, base64Bytes) {
            return request('lan:print', { ip: ip, port: port, bytes: base64Bytes });
          }
        };

        // BBPOS WisePad 3 card reader. The web POS creates the charge
        // (POST /payments/terminal/charge/mobile → clientSecret), then:
        //   OrderHubTerminal.connect(stripeLocationId?)  → pair the reader
        //   OrderHubTerminal.pay(clientSecret)           → collect on reader
        // then polls /payments/terminal/charge/status to settle the order.
        window.OrderHubTerminal = {
          isReady: true,
          connect: function (stripeLocationId, simulated) {
            return request('terminal:connect', {
              stripeLocationId: stripeLocationId || null,
              simulated: !!simulated
            });
          },
          pay: function (clientSecret) {
            return request('terminal:pay', { clientSecret: clientSecret });
          }
        };
        true;
      })();
    `,
    [],
  );

  const respond = (reqId: string, value: unknown) => {
    webRef.current?.injectJavaScript(
      `window.__ohbtResolve(${JSON.stringify(reqId)}, ${JSON.stringify(value)}); true;`,
    );
  };
  const reject = (reqId: string, msg: string) => {
    webRef.current?.injectJavaScript(
      `window.__ohbtReject(${JSON.stringify(reqId)}, ${JSON.stringify(msg)}); true;`,
    );
  };

  const onMessage = async (e: WebViewMessageEvent) => {
    try {
      const msg = JSON.parse(e.nativeEvent.data);
      if (msg?.type === "signout") {
        pushDbg("web msg: signout");
        await signOutGoogle();
        onSignOut();
      } else if (msg?.type === "openExternal" && msg?.url) {
        await Linking.openURL(String(msg.url));
      } else if (msg?.type === "bt:list" && msg?.reqId) {
        try {
          await ensureBtPermissions();
          const devices = await listBondedDevices();
          respond(
            msg.reqId,
            devices.map((d) => ({ name: d.name, address: d.address })),
          );
        } catch (err: any) {
          reject(msg.reqId, err?.message ?? "Bluetooth list failed");
        }
      } else if (msg?.type === "bt:print" && msg?.reqId && msg?.payload) {
        try {
          const { mac, bytes } = msg.payload as { mac: string; bytes: string };
          if (!mac || !bytes) throw new Error("mac + bytes required");
          const buf = base64ToBytes(bytes);
          await sendBytesOverBt(mac, buf);
          respond(msg.reqId, { ok: true });
        } catch (err: any) {
          reject(msg.reqId, err?.message ?? "Bluetooth print failed");
        }
      } else if (msg?.type === "lan:print" && msg?.reqId && msg?.payload) {
        try {
          const { ip, port, bytes } = msg.payload as {
            ip: string;
            port?: number;
            bytes: string;
          };
          if (!ip || !bytes) throw new Error("ip + bytes required");
          const buf = base64ToBytes(bytes);
          await sendBytesOverTcp(ip, port, buf);
          respond(msg.reqId, { ok: true });
        } catch (err: any) {
          reject(msg.reqId, err?.message ?? "LAN print failed");
        }
      } else if (msg?.type === "terminal:connect" && msg?.reqId) {
        try {
          const { stripeLocationId, simulated } = (msg.payload ?? {}) as {
            stripeLocationId?: string | null;
            simulated?: boolean;
          };
          const res = await terminalController.connect(
            stripeLocationId || undefined,
            !!simulated,
          );
          respond(msg.reqId, res);
        } catch (err: any) {
          reject(msg.reqId, err?.message ?? "Reader connect failed");
        }
      } else if (msg?.type === "terminal:pay" && msg?.reqId && msg?.payload) {
        try {
          const { clientSecret } = msg.payload as { clientSecret: string };
          if (!clientSecret) throw new Error("clientSecret required");
          const res = await terminalController.pay(clientSecret);
          respond(msg.reqId, res);
        } catch (err: any) {
          reject(msg.reqId, err?.message ?? "Card payment failed");
        }
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
    pushDbg(`nav ${shortPath(u)}${isDashboardLogin ? "  → BOUNCE" : ""}`);
    // eslint-disable-next-line no-console
    console.log("[OH nav]", u, isDashboardLogin ? "→ BOUNCE TO LOGIN" : "");
    if (isDashboardLogin) {
      await signOutGoogle();
      onSignOut();
    }
  };

  return (
    <SafeAreaView style={styles.container} edges={["top", "bottom"]}>
      <View style={styles.flex}>
        <WebView
          ref={webRef}
          source={{ uri: initialUrl }}
          injectedJavaScriptBeforeContentLoaded={injectedBeforeLoad}
          onMessage={onMessage}
          onNavigationStateChange={handleNavStateChange}
          onLoadEnd={() => setLoaded(true)}
          onError={(e) => {
            pushDbg(`load err: ${e.nativeEvent.description ?? "?"}`);
            // eslint-disable-next-line no-console
            console.log("[OH webview error]", JSON.stringify(e.nativeEvent));
          }}
          onHttpError={(e) => {
            pushDbg(`http ${e.nativeEvent.statusCode} ${shortPath(e.nativeEvent.url)}`);
            // eslint-disable-next-line no-console
            console.log(
              "[OH http error]",
              e.nativeEvent.statusCode,
              e.nativeEvent.url,
            );
          }}
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
          // No pull-to-refresh — the web POS has its own refresh button
          // and pulling on a scrollable list intercepts the gesture and
          // makes vertical scrolling on long order lists feel sticky.
          pullToRefreshEnabled={false}
          overScrollMode="never"
          bounces={false}
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

        {/* TEMP login-loop diagnostic overlay — screenshot this. Remove later. */}
        {dbg.length > 0 && (
          <View pointerEvents="none" style={styles.dbgOverlay}>
            {dbg.map((l, i) => (
              <Text key={i} style={styles.dbgText}>
                {l}
              </Text>
            ))}
          </View>
        )}
      </View>

    </SafeAreaView>
  );
}

// base64 → Uint8Array. Compact and ASCII-only friendly; the dashboard
// is responsible for sending properly-encoded ESC/POS payloads.
function base64ToBytes(b64: string): Uint8Array {
  const clean = b64.replace(/\s+/g, "");
  const chars =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const map: Record<string, number> = {};
  for (let i = 0; i < chars.length; i++) map[chars[i]!] = i;
  const out: number[] = [];
  let i = 0;
  while (i < clean.length) {
    const c0 = clean[i++] ?? "A";
    const c1 = clean[i++] ?? "A";
    const c2 = clean[i++] ?? "=";
    const c3 = clean[i++] ?? "=";
    const n =
      (map[c0]! << 18) |
      (map[c1]! << 12) |
      ((c2 === "=" ? 0 : map[c2]!) << 6) |
      (c3 === "=" ? 0 : map[c3]!);
    out.push((n >> 16) & 0xff);
    if (c2 !== "=") out.push((n >> 8) & 0xff);
    if (c3 !== "=") out.push(n & 0xff);
  }
  return new Uint8Array(out);
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
  dbgOverlay: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    backgroundColor: "rgba(0,0,0,0.82)",
    paddingHorizontal: 8,
    paddingVertical: 6,
  },
  dbgText: {
    color: "#4ade80",
    fontSize: 10,
    fontFamily: "monospace",
  },
});
