import { Ionicons } from "@expo/vector-icons";
import * as Linking from "expo-linking";
import { useCallback, useState } from "react";
import { ActivityIndicator, Modal, Platform, Pressable, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import WebView from "react-native-webview";
import { brand } from "../brand";
import { colors } from "../theme";

/**
 * Hosted payment pages the storefront sends a card order to. These open in
 * PaymentSheet, not in the storefront's own WebView.
 *
 * Why a second WebView: wallets need WebView settings the storefront one
 * can't have.
 *   • iOS: Apple Pay only works in a WKWebView that injects NO scripts
 *     (`enableApplePay` turns injection off) — and the storefront WebView
 *     runs the session/bridge scripts on every page.
 *   • Android: Google Pay needs the Payment Request API switched on
 *     (`paymentRequestEnabled`) plus GOOGLE_PAY_SUPPORTED in a custom user
 *     agent. Without them Mollie's Google Pay button fell back to a Google
 *     sign-in page and failed ("Google Pay couldn't load properly because
 *     this App uses a WebView", OR_BIBED_15).
 * Top-frame only: Stripe's embedded card fields are iframes on our own page
 * and must stay where they are.
 */
const PAYMENT_HOSTS = [
  /(^|\.)mollie\.com$/i,
  /^checkout\.stripe\.com$/i,
  /^pay\.dojo\.tech$/i,
  /(^|\.)tap\.company$/i,
];

// React Native's URL is only partly implemented (no .host), so parse by hand
// like the storefront bridge does.
function hostOf(url: string): string {
  return (url.match(/^https?:\/\/([^/?#:]+)/i)?.[1] ?? "").toLowerCase();
}
function pathOf(url: string): string {
  return url.replace(/^https?:\/\/[^/?#]+/i, "") || "/";
}

export function isPaymentPage(url: string): boolean {
  const host = hostOf(url);
  return !!host && PAYMENT_HOSTS.some((re) => re.test(host));
}

/** Our own storefront pages — where a payment page hands the customer back. */
function isStorefrontPage(url: string): boolean {
  const host = hostOf(url);
  if (!host) return false;
  if (host === hostOf(brand.storefrontUrl)) return true;
  // Both www and bare orderhubsolutions.com, and the /order/ path on any
  // brand custom domain.
  return /(^|\.)orderhubsolutions\.com$/.test(host) || (!isPaymentPage(url) && pathOf(url).startsWith("/order/"));
}

// Google's documented flag for wallets in an Android WebView with a custom
// user agent; harmless on iOS.
const USER_AGENT_SUFFIX = `OrderHubApp/${brand.slug} GOOGLE_PAY_SUPPORTED`;

export function PaymentSheet({
  url,
  onReturn,
  onClose,
}: {
  url: string | null;
  /** The payment page sent the customer back to the storefront. */
  onReturn: (url: string) => void;
  /** The customer closed the sheet without finishing. */
  onClose: () => void;
}) {
  const insets = useSafeAreaInsets();
  const [loading, setLoading] = useState(true);

  const onShouldStartLoadWithRequest = useCallback(
    (req: { url: string; isTopFrame?: boolean }) => {
      if (req.isTopFrame !== false && isStorefrontPage(req.url)) {
        onReturn(req.url);
        return false;
      }
      if (/^https?:/i.test(req.url) || req.url.startsWith("about:")) return true;
      // Bank apps (3-D Secure), wallet and intent: links — hand to the OS.
      Linking.openURL(req.url).catch(() => {});
      return false;
    },
    [onReturn],
  );

  return (
    <Modal visible={!!url} animationType="slide" presentationStyle="fullScreen" onRequestClose={onClose}>
      <View style={[styles.root, { paddingTop: insets.top }]}>
        <View style={styles.bar}>
          <Pressable accessibilityLabel="Close payment" hitSlop={12} onPress={onClose} style={styles.barButton}>
            <Ionicons name="close" size={24} color={colors.text} />
          </Pressable>
          <View style={styles.titleRow}>
            <Ionicons name="lock-closed" size={14} color={colors.muted} />
            <Text style={styles.title} numberOfLines={1}>
              Secure payment
            </Text>
          </View>
          <View style={styles.barButton} />
        </View>
        {url ? (
          <WebView
            source={{ uri: url }}
            style={styles.web}
            onShouldStartLoadWithRequest={onShouldStartLoadWithRequest}
            onLoadStart={() => setLoading(true)}
            onLoadEnd={() => setLoading(false)}
            applicationNameForUserAgent={USER_AGENT_SUFFIX}
            // Apple Pay (iOS): only in a WebView with no injected scripts —
            // this one injects none.
            enableApplePay={Platform.OS === "ios"}
            // Google Pay (Android): Payment Request API in the WebView. Also
            // needs the PAY intent <queries> in the manifest (plugin).
            paymentRequestEnabled
            setSupportMultipleWindows={false}
            sharedCookiesEnabled={false}
          />
        ) : null}
        {loading ? (
          <View style={styles.loading} pointerEvents="none">
            <ActivityIndicator color={colors.primary} />
          </View>
        ) : null}
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.card },
  bar: {
    height: 48,
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  barButton: { width: 40, height: 40, alignItems: "center", justifyContent: "center" },
  titleRow: { flex: 1, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6 },
  title: { fontSize: 16, fontWeight: "600", color: colors.text },
  web: { flex: 1 },
  loading: { position: "absolute", top: 120, left: 0, right: 0, alignItems: "center" },
});
