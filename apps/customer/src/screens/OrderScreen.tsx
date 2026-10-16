import { Ionicons } from "@expo/vector-icons";
import { useFocusEffect, type RouteProp, useRoute } from "@react-navigation/native";
import * as Linking from "expo-linking";
import { useCallback, useEffect, useRef, useState } from "react";
import { ActivityIndicator, BackHandler, Pressable, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import WebView, { type WebViewMessageEvent, type WebViewNavigation } from "react-native-webview";
import { Button } from "../components/Button";
import { brand } from "../brand";
import { openOrder, type TabParams } from "../navigation";
import { saveOrder } from "../orders";
import { followOrder } from "../push";
import { type BridgeMessage, INJECTED_JS, orderFromUrl, slugFromUrl } from "../storefront-bridge";
import { colors } from "../theme";

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
      openOrder(orderId, slug);
    }
  }, []);

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
      if (msg.type === "url") onUrl(msg.url);
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
      onUrl(nav.url);
    },
    [onUrl],
  );

  const onShouldStartLoadWithRequest = useCallback((req: { url: string }) => {
    if (/^https?:/i.test(req.url) || req.url.startsWith("about:")) return true;
    // tel:, mailto:, maps, wallet links — hand them to the OS.
    Linking.openURL(req.url).catch(() => {});
    return false;
  }, []);

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
        ref={webview}
        source={{ uri: source }}
        style={[styles.web, failed && styles.hidden]}
        injectedJavaScriptBeforeContentLoaded={INJECTED_JS}
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
        decelerationRate="normal"
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
