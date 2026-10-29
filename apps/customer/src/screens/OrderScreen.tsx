import { Ionicons } from "@expo/vector-icons";
import { useFocusEffect, type RouteProp, useRoute } from "@react-navigation/native";
import * as Linking from "expo-linking";
import { useCallback, useEffect, useRef, useState } from "react";
import { ActivityIndicator, Alert, BackHandler, Pressable, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import WebView, { type WebViewMessageEvent, type WebViewNavigation } from "react-native-webview";
import {
  availableProviders,
  type Provider,
  sessionScript,
  signIn,
  SignInCancelled,
  storefrontSessionChanged,
  storefrontSignedOut,
  useAuth,
} from "../auth";
import { Button } from "../components/Button";
import { isPaymentPage, PaymentSheet } from "../components/PaymentSheet";
import { brand } from "../brand";
import { openOrder, type TabParams } from "../navigation";
import { saveOrder } from "../orders";
import { followOrder } from "../push";
import { type BridgeMessage, INJECTED_JS, orderFromUrl, slugFromUrl } from "../storefront-bridge";
import { colors } from "../theme";
import { useShop } from "../shop";

// Menu and checkout are the storefront itself (phase 1): one menu, one set
// of prices and payment flows, no second implementation to drift. The native
// shell wraps it: it notices orders, follows them for push, and hands
// tracking to the native screen.
export function OrderScreen() {
  const route = useRoute<RouteProp<TabParams, "Order">>();
  const insets = useSafeAreaInsets();
  const webview = useRef<WebView>(null);
  const [source, setSource] = useState(brand.storefrontUrl);
  const [canGoBack, setCanGoBack] = useState(false);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const handled = useRef(new Set<string>());
  const auth = useAuth();
  const [providers, setProviders] = useState<Provider[]>([]);
  const [webKey, setWebKey] = useState(0);
  const lastUrl = useRef<string | null>(null);
  const shownVersion = useRef(auth.version);
  // A hosted payment page (Mollie, Stripe Checkout, Dojo, Tap) open in the
  // wallet-capable sheet over the menu. See PaymentSheet for why.
  const [payUrl, setPayUrl] = useState<string | null>(null);

  useEffect(() => {
    availableProviders().then(setProviders);
  }, []);

  // The list usually arrives after the page has started loading (it waits on
  // the admin switch from the API), and the session script only runs as a
  // page starts — so hand the late answer to the page that is already open.
  // Without this, opening the Menu tab first left the sign-in box with email
  // only until the next full page load.
  useEffect(() => {
    if (!providers.length) return;
    webview.current?.injectJavaScript(
      `(function(){var a=window.OrderHubApp;if(a){a.signInProviders=${JSON.stringify(providers)};` +
        `window.dispatchEvent(new Event("orderhubapp:change"));}})();true;`,
    );
  }, [providers]);

  // A native sign-in or sign-out: reload the page the customer is on with
  // the new session in place (remounting, because the session script only
  // runs as a page starts loading).
  useEffect(() => {
    if (auth.version === shownVersion.current) return;
    shownVersion.current = auth.version;
    setSource(lastUrl.current ?? brand.storefrontUrl);
    setWebKey((k) => k + 1);
  }, [auth.version]);

  // Multi-shop app: a different shop picked → its menu, from the top.
  const shop = useShop();
  const shownShop = useRef(shop?.locationId);
  useEffect(() => {
    if (shop?.locationId === shownShop.current) return;
    shownShop.current = shop?.locationId;
    lastUrl.current = null;
    setSource(brand.storefrontUrl);
    setWebKey((k) => k + 1);
  }, [shop?.locationId]);

  // A notification or the Home screen asked for a particular page.
  useEffect(() => {
    const url = route.params?.url;
    if (!url) return;
    // Asked for on purpose ("View on the website"), so don't bounce straight
    // back to the native tracker for the order this page is about.
    const order = orderFromUrl(url);
    if (order) handled.current.add(`${order.orderId}:true`);
    setSource(url);
  }, [route.params?.url, route.params?.nonce]);

  // Android back steps back through the storefront before leaving the tab.
  useFocusEffect(
    useCallback(() => {
      const sub = BackHandler.addEventListener("hardwareBackPress", () => {
        if (!canGoBack) return false;
        webview.current?.goBack();
        return true;
      });
      return () => sub.remove();
    }, [canGoBack]),
  );

  const noteOrder = useCallback(async (orderId: string, slug: string, open: boolean) => {
    await saveOrder(orderId, slug);
    followOrder(orderId, slug);
    const key = `${orderId}:${open}`;
    if (open && !handled.current.has(key)) {
      handled.current.add(key);
      backToMenu.current = true;
      openOrder(orderId, slug);
    }
  }, []);

  // The tracker opened over this tab while the page underneath moved on to
  // the storefront's own tracking/confirmation page. Coming back (the
  // tracker's back arrow) lands on the menu again, not on a second, web
  // version of the tracker. Done on return rather than at checkout so the
  // storefront has finished clearing the basket first.
  const backToMenu = useRef(false);
  useFocusEffect(
    useCallback(() => {
      if (!backToMenu.current) return;
      backToMenu.current = false;
      lastUrl.current = null;
      setSource(brand.storefrontUrl);
      setWebKey((k) => k + 1);
    }, []),
  );

  const onUrl = useCallback(
    (url: string) => {
      const order = orderFromUrl(url);
      if (order) noteOrder(order.orderId, order.slug, true);
    },
    [noteOrder],
  );

  const onMessage = useCallback(
    (e: WebViewMessageEvent) => {
      let msg: BridgeMessage;
      try {
        msg = JSON.parse(e.nativeEvent.data);
      } catch {
        return;
      }
      if (msg.type === "url") {
        lastUrl.current = msg.url;
        onUrl(msg.url);
      }
      if (msg.type === "auth") storefrontSessionChanged(msg.token);
      if (msg.type === "signed-out") storefrontSignedOut(msg.nonce);
      if (msg.type === "sign-in" && (msg.provider === "apple" || msg.provider === "google")) {
        signIn(msg.provider).catch((err) => {
          if (err instanceof SignInCancelled) return;
          Alert.alert("Couldn't sign you in", err?.message ?? "Please try again.");
        });
      }
      if (msg.type === "checkout") {
        const slug = slugFromUrl(msg.url) ?? slugFromUrl(brand.storefrontUrl);
        if (!slug) return;
        // Card orders leave for Stripe (or a wallet sheet) first: follow them
        // now, but only open the tracker once they are actually placed.
        const placed = !msg.checkoutUrl && !msg.pendingPayment;
        noteOrder(msg.orderId, slug, placed);
      }
    },
    [noteOrder, onUrl],
  );

  const onNavigationStateChange = useCallback(
    (nav: WebViewNavigation) => {
      setCanGoBack(nav.canGoBack);
      if (/^https?:/i.test(nav.url)) lastUrl.current = nav.url;
      onUrl(nav.url);
    },
    [onUrl],
  );

  const onShouldStartLoadWithRequest = useCallback((req: { url: string; isTopFrame?: boolean }) => {
    // The storefront leaving for a hosted payment page: open it in the
    // payment sheet instead, where Apple Pay / Google Pay work.
    if (req.isTopFrame !== false && isPaymentPage(req.url)) {
      setPayUrl(req.url);
      return false;
    }
    if (/^https?:/i.test(req.url) || req.url.startsWith("about:")) return true;
    // tel:, mailto:, maps, wallet links — hand them to the OS.
    Linking.openURL(req.url).catch(() => {});
    return false;
  }, []);

  const pageScript = sessionScript(auth, providers) + INJECTED_JS;

  return (
    <View style={[styles.root, { paddingTop: insets.top }]}>
      <View style={styles.bar}>
        <Pressable
          accessibilityLabel="Back"
          hitSlop={12}
          onPress={() => webview.current?.goBack()}
          disabled={!canGoBack}
          style={styles.barButton}
        >
          <Ionicons name="chevron-back" size={24} color={canGoBack ? colors.text : colors.border} />
        </Pressable>
        <Text style={styles.title} numberOfLines={1}>
          {brand.name}
        </Text>
        <Pressable accessibilityLabel="Reload" hitSlop={12} onPress={() => webview.current?.reload()} style={styles.barButton}>
          <Ionicons name="refresh" size={21} color={colors.text} />
        </Pressable>
      </View>
      {failed ? (
        <View style={styles.center}>
          <Ionicons name="cloud-offline-outline" size={44} color={colors.muted} />
          <Text style={styles.failTitle}>Can't reach the menu</Text>
          <Text style={styles.failText}>Check your connection and try again.</Text>
          <Button
            title="Try again"
            onPress={() => {
              setFailed(false);
              webview.current?.reload();
            }}
            style={{ marginTop: 16, alignSelf: "stretch" }}
          />
        </View>
      ) : null}
      <WebView
        key={webKey}
        ref={webview}
        source={{ uri: source }}
        style={[styles.web, failed && styles.hidden]}
        injectedJavaScriptBeforeContentLoaded={pageScript}
        // Again once the page has loaded. Android runs the "before" script
        // from onPageStarted, which races the new document: when it loses,
        // the script lands on the old page and the storefront runs without
        // the checkout hook, so a cash order (confirmed in place, no URL
        // change) was never followed and every stage logged "no
        // subscribers". Both scripts guard themselves, so this is a no-op
        // whenever the first one took.
        injectedJavaScript={pageScript}
        onMessage={onMessage}
        onNavigationStateChange={onNavigationStateChange}
        onShouldStartLoadWithRequest={onShouldStartLoadWithRequest}
        onLoadStart={() => setLoading(true)}
        onLoadEnd={() => setLoading(false)}
        onError={() => setFailed(true)}
        applicationNameForUserAgent={`OrderHubApp/${brand.slug}`}
        allowsBackForwardNavigationGestures
        setSupportMultipleWindows={false}
        sharedCookiesEnabled
        pullToRefreshEnabled
        // No decelerationRate: Android passes "normal" straight to a numeric
        // native prop and the ClassCastException blanks the whole app.
      />
      <PaymentSheet
        url={payUrl}
        onReturn={(url) => {
          // Back from the provider (paid, or cancelled to the menu): show
          // that page in the storefront WebView with its scripts, so the
          // order is followed and the tracker opens as before.
          setPayUrl(null);
          lastUrl.current = url;
          setSource(url);
          setWebKey((k) => k + 1);
          onUrl(url);
        }}
        onClose={() => setPayUrl(null)}
      />
      {loading && !failed ? (
        <View style={styles.loading} pointerEvents="none">
          <ActivityIndicator color={colors.primary} />
        </View>
      ) : null}
    </View>
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
  title: { flex: 1, textAlign: "center", fontSize: 17, fontWeight: "700", color: colors.text },
  web: { flex: 1 },
  hidden: { height: 0, flex: 0 },
  loading: { position: "absolute", top: 120, left: 0, right: 0, alignItems: "center" },
  center: { flex: 1, alignItems: "center", justifyContent: "center", padding: 32 },
  failTitle: { fontSize: 18, fontWeight: "700", color: colors.text, marginTop: 12 },
  failText: { fontSize: 15, color: colors.muted, marginTop: 4, textAlign: "center" },
});
