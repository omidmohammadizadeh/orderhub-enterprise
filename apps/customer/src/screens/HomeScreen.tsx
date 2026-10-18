import { Ionicons } from "@expo/vector-icons";
import { useIsFocused, useNavigation } from "@react-navigation/native";
import { StatusBar } from "expo-status-bar";
import * as Linking from "expo-linking";
import { useCallback, useEffect, useState } from "react";
import { Image, Platform, Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { getStoreInfo, imageUrl, type StoreInfo } from "../api";
import { brand } from "../brand";
import { Button } from "../components/Button";
import { Card } from "../components/Card";
import { StatusPill } from "../components/StatusPill";
import { isFinished, money, orderLabel } from "../format";
import { openOrder } from "../navigation";
import { useSavedOrders } from "../orders";
import { getOffersPreference, setOffers } from "../push";
import { colors, radius } from "../theme";
import { useOrderStatus } from "../useOrderStatus";

const DAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

function todaysHours(info: StoreInfo): string | null {
  const slots = info.location.openingHours?.[DAYS[new Date().getDay()]];
  if (!slots?.length) return null;
  return slots.map((s) => `${s.from}–${s.to}`).join(", ");
}

function offerText(c: NonNullable<StoreInfo["campaign"]>, currency: string | null): string {
  const what = c.percentageOff ? `${c.percentageOff}% off` : c.amountOff ? `${money(c.amountOff, currency)} off` : c.name;
  return c.minOrder ? `${what} orders over ${money(c.minOrder, currency)}` : `${what} your order`;
}

export function HomeScreen() {
  const insets = useSafeAreaInsets();
  const navigation = useNavigation();
  const focused = useIsFocused();
  const orders = useSavedOrders();
  const [info, setInfo] = useState<StoreInfo | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [offersAsked, setOffersAsked] = useState(true);

  const load = useCallback(async () => {
    try {
      setInfo(await getStoreInfo());
      return true;
    } catch {
      /* Home still works from the brand config alone */
      return false;
    }
  }, []);

  // The very first launch often fires before the network is up (or while the
  // API wakes), and one miss left Home bare with no banner, logo or hours
  // until a manual pull-to-refresh. Retry a few times with a growing gap.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      for (let attempt = 0; attempt < 5 && !cancelled; attempt++) {
        if (await load()) return;
        await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
      }
    })();
    getOffersPreference().then((v) => setOffersAsked(v !== null));
    return () => {
      cancelled = true;
    };
  }, [load]);

  const startOrder = () => navigation.navigate("Order" as never);
  const latest = orders?.[0];
  const banner = imageUrl(info?.menu?.bannerImage ?? info?.menu?.heroImage);
  const logo = imageUrl(info?.brand?.logoUrl ?? info?.menu?.logoImage);
  const currency = info?.location.currency ?? null;
  const hours = info ? todaysHours(info) : null;

  return (
    <ScrollView
      style={styles.root}
      contentContainerStyle={{ paddingBottom: 32 }}
      refreshControl={
        <RefreshControl
          refreshing={refreshing}
          tintColor={colors.primary}
          onRefresh={async () => {
            setRefreshing(true);
            await load();
            setRefreshing(false);
          }}
        />
      }
    >
      {focused ? <StatusBar style="light" /> : null}
      <View style={[styles.hero, { paddingTop: insets.top }]}>
        {banner ? <Image source={{ uri: banner }} style={StyleSheet.absoluteFill} resizeMode="cover" /> : null}
        <View style={[StyleSheet.absoluteFill, styles.heroShade, !banner && { backgroundColor: colors.primary }]} />
      </View>

      <View style={styles.body}>
        <Card style={styles.identity}>
          {logo ? <Image source={{ uri: logo }} style={styles.logo} resizeMode="contain" /> : null}
          <View style={{ flex: 1 }}>
            <Text style={styles.name}>{brand.name}</Text>
            {info ? (
              <View style={styles.metaRow}>
                <View style={[styles.openDot, { backgroundColor: info.isOpen ? colors.success : colors.danger }]} />
                <Text style={styles.meta}>
                  {info.isOpen ? "Open now" : "Closed"}
                  {hours ? ` · Today ${hours}` : ""}
                </Text>
              </View>
            ) : null}
          </View>
        </Card>

        {info?.campaign ? (
          <Pressable onPress={startOrder} style={[styles.offer, { backgroundColor: colors.primary }]}>
            <Ionicons name="pricetag" size={18} color={colors.onPrimary} />
            <Text style={styles.offerText}>{offerText(info.campaign, currency)}</Text>
          </Pressable>
        ) : null}

        <Button title={info && !info.isOpen ? "Order for later" : "Start your order"} onPress={startOrder} />

        {info?.directConfig ? (
          <View style={styles.modes}>
            {info.directConfig.acceptsCollection ? (
              <Card style={styles.mode}>
                <Ionicons name="bag-handle-outline" size={22} color={colors.primary} />
                <Text style={styles.modeTitle}>Collection</Text>
                {info.directConfig.collectionPrepMinutes ? (
                  <Text style={styles.modeMeta}>~{info.directConfig.collectionPrepMinutes} min</Text>
                ) : null}
              </Card>
            ) : null}
            {info.directConfig.acceptsDelivery ? (
              <Card style={styles.mode}>
                <Ionicons name="bicycle-outline" size={22} color={colors.primary} />
                <Text style={styles.modeTitle}>Delivery</Text>
                {info.directConfig.deliveryPrepMinutes ? (
                  <Text style={styles.modeMeta}>~{info.directConfig.deliveryPrepMinutes} min</Text>
                ) : null}
              </Card>
            ) : null}
          </View>
        ) : null}

        {latest ? <LatestOrder orderId={latest.orderId} slug={latest.slug} /> : null}

        {!offersAsked ? (
          <Card>
            <Text style={styles.sectionTitle}>Get our offers first?</Text>
            <Text style={styles.muted}>
              We'll send the occasional deal and news from {brand.name}. Order updates come either way.
            </Text>
            <View style={styles.offerButtons}>
              <Button
                title="Yes please"
                onPress={() => {
                  setOffersAsked(true);
                  setOffers(true);
                }}
                style={{ flex: 1 }}
              />
              <Button
                title="Not now"
                variant="secondary"
                onPress={() => {
                  setOffersAsked(true);
                  setOffers(false);
                }}
                style={{ flex: 1 }}
              />
            </View>
          </Card>
        ) : null}

        {info?.topSellers?.length ? (
          <View>
            <Text style={styles.sectionTitle}>Popular right now</Text>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 12 }}>
              {info.topSellers.slice(0, 10).map((item) => {
                const img = imageUrl(item.imageUrl);
                return (
                  <Pressable key={item.id} onPress={startOrder} style={styles.item}>
                    {img ? (
                      <Image source={{ uri: img }} style={styles.itemImage} />
                    ) : (
                      <View style={[styles.itemImage, styles.itemPlaceholder]}>
                        <Ionicons name="restaurant-outline" size={28} color={colors.muted} />
                      </View>
                    )}
                    <Text style={styles.itemName} numberOfLines={2}>
                      {item.name}
                    </Text>
                    <Text style={styles.itemPrice}>{money(item.basePrice, currency)}</Text>
                  </Pressable>
                );
              })}
            </ScrollView>
          </View>
        ) : null}

        {info ? (
          <Card>
            <Text style={styles.sectionTitle}>Find us</Text>
            <Text style={styles.muted}>
              {[info.location.addressLine1, info.location.postcode].filter(Boolean).join(", ")}
            </Text>
            <View style={styles.offerButtons}>
              {info.location.phone ? (
                <Button
                  title="Call"
                  variant="secondary"
                  onPress={() => Linking.openURL(`tel:${info.location.phone!.replace(/\s+/g, "")}`)}
                  style={{ flex: 1 }}
                />
              ) : null}
              <Button
                title="Directions"
                variant="secondary"
                onPress={() => {
                  const q = encodeURIComponent(
                    [info.location.name, info.location.addressLine1, info.location.postcode].filter(Boolean).join(", "),
                  );
                  Linking.openURL(
                    Platform.OS === "ios" ? `https://maps.apple.com/?q=${q}` : `https://www.google.com/maps/search/?api=1&query=${q}`,
                  );
                }}
                style={{ flex: 1 }}
              />
            </View>
          </Card>
        ) : null}
      </View>
    </ScrollView>
  );
}

function LatestOrder({ orderId, slug }: { orderId: string; slug: string }) {
  const { order } = useOrderStatus(orderId);
  if (!order || isFinished(order.status)) return null;
  return (
    <Pressable onPress={() => openOrder(orderId, slug)}>
      <Card style={styles.latest}>
        <View style={{ flex: 1, gap: 6 }}>
          <Text style={styles.sectionTitle}>Your order {orderLabel(order)}</Text>
          <StatusPill order={order} />
        </View>
        <Ionicons name="chevron-forward" size={20} color={colors.muted} />
      </Card>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.background },
  hero: { height: 210, overflow: "hidden" },
  heroShade: { backgroundColor: "rgba(0,0,0,0.15)" },
  body: { paddingHorizontal: 16, gap: 14, marginTop: -48 },
  identity: { flexDirection: "row", alignItems: "center", gap: 14 },
  logo: { width: 64, height: 64, borderRadius: 14, backgroundColor: colors.card },
  name: { fontSize: 22, fontWeight: "800", color: colors.text },
  metaRow: { flexDirection: "row", alignItems: "center", gap: 6, marginTop: 4 },
  openDot: { width: 8, height: 8, borderRadius: 4 },
  meta: { fontSize: 14, color: colors.muted, flexShrink: 1 },
  offer: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    borderRadius: radius.button,
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  offerText: { color: colors.onPrimary, fontSize: 15, fontWeight: "700", flex: 1 },
  modes: { flexDirection: "row", gap: 12 },
  mode: { flex: 1, gap: 4 },
  modeTitle: { fontSize: 15, fontWeight: "700", color: colors.text },
  modeMeta: { fontSize: 13, color: colors.muted },
  latest: { flexDirection: "row", alignItems: "center" },
  sectionTitle: { fontSize: 17, fontWeight: "700", color: colors.text, marginBottom: 8 },
  muted: { fontSize: 14, color: colors.muted, lineHeight: 20 },
  offerButtons: { flexDirection: "row", gap: 10, marginTop: 14 },
  item: { width: 150 },
  itemImage: { width: 150, height: 110, borderRadius: 12, backgroundColor: colors.border },
  itemPlaceholder: { alignItems: "center", justifyContent: "center" },
  itemName: { fontSize: 14, fontWeight: "600", color: colors.text, marginTop: 6 },
  itemPrice: { fontSize: 14, color: colors.muted, marginTop: 2 },
});
