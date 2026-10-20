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
import { AccessBanner } from "../components/AccessBanner";
import { StatusPill } from "../components/StatusPill";
import { isFinished, money, orderLabel } from "../format";
import { openOrder, openShopPicker, openStorefront } from "../navigation";
import { useSavedOrders } from "../orders";
import { getOffersPreference, setOffers } from "../push";
import { colors, radius } from "../theme";
import { useOrderStatus } from "../useOrderStatus";
import { multiShop, useShop } from "../shop";

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
  // Multi-shop app: the shop the customer picked. Switching shop reloads Home.
  const shop = useShop();

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
  }, [load, shop?.locationId]);

  const startOrder = () => navigation.navigate("Order" as never);
  const latest = orders?.[0];
  const banner = imageUrl(info?.menu?.bannerImage ?? info?.menu?.heroImage);
  const logo = imageUrl(info?.brand?.logoUrl ?? info?.menu?.logoImage);
  const currency = info?.location.currency ?? null;
  const hours = info ? todaysHours(info) : null;
  // Where to send people. A multi-shop app uses the picked shop's own address
  // and phone: the storefront overlays the BRAND's address, which for a brand
  // trading at several shops is at best one of them.
  const findUs = (() => {
    if (multiShop && shop) {
      const address = [shop.address, shop.postcode].filter(Boolean).join(", ");
      return {
        address,
        phone: shop.phone ?? info?.location.phone ?? null,
        query: shop.lat != null && shop.lng != null ? `${shop.lat},${shop.lng}` : [shop.name, address].join(", "),
      };
    }
    if (!info) return null;
    return {
      address: [info.location.addressLine1, info.location.postcode].filter(Boolean).join(", "),
      phone: info.location.phone,
      query: [info.location.name, info.location.addressLine1, info.location.postcode].filter(Boolean).join(", "),
    };
  })();

  const path = brand.storefrontUrl.replace(/^https?:\/\/[^/]+/, "");
  const openMode = (mode: "delivery" | "collection") =>
    openStorefront(`${path}${path.includes("?") ? "&" : "?"}mode=${mode}`);
  const dc = info?.directConfig;
  const modes = [
    dc?.acceptsDelivery
      ? { key: "delivery" as const, icon: "bicycle" as const, title: "Delivery", sub: dc.deliveryPrepMinutes ? `${dc.deliveryPrepMinutes}–${dc.deliveryPrepMinutes + 15} min` : "To your door" }
      : null,
    dc?.acceptsCollection
      ? { key: "collection" as const, icon: "bag-handle" as const, title: "Collection", sub: dc.collectionPrepMinutes ? `Ready in ~${dc.collectionPrepMinutes} min` : "Skip the queue" }
      : null,
  ].filter((m): m is NonNullable<typeof m> => !!m);

  return (
    <ScrollView
      style={styles.root}
      contentContainerStyle={{ paddingBottom: 40 }}
      showsVerticalScrollIndicator={false}
      refreshControl={
        <RefreshControl
          refreshing={refreshing}
          tintColor="#fff"
          onRefresh={async () => {
            setRefreshing(true);
            await load();
            setRefreshing(false);
          }}
        />
      }
    >
      {focused ? <StatusBar style="light" /> : null}
      <View style={[styles.hero, { paddingTop: insets.top + 8 }]}>
        {banner ? <Image source={{ uri: banner }} style={StyleSheet.absoluteFill} resizeMode="cover" /> : null}
        <View style={[StyleSheet.absoluteFill, styles.heroShade, !banner && { backgroundColor: colors.primary }]} />

        {multiShop && shop ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Ordering from ${shop.name}. Change shop`}
            onPress={openShopPicker}
            hitSlop={8}
            style={({ pressed }) => [styles.shopChip, pressed && { opacity: 0.8 }]}
          >
            <Ionicons name="location" size={15} color="#fff" />
            <View style={{ flexShrink: 1 }}>
              <Text style={styles.shopChipLabel}>Ordering from</Text>
              <Text style={styles.shopChipName} numberOfLines={1}>
                {shop.name}
              </Text>
            </View>
            <Ionicons name="chevron-down" size={16} color="#fff" />
          </Pressable>
        ) : null}

        <View style={styles.heroFoot}>
          {logo ? (
            <View style={styles.logoWrap}>
              <Image source={{ uri: logo }} style={styles.logo} resizeMode="contain" />
            </View>
          ) : null}
          <View style={{ flex: 1 }}>
            <Text style={styles.name} numberOfLines={2}>
              {brand.name}
            </Text>
            {info ? (
              <View style={styles.metaRow}>
                <View style={[styles.statusPill, { backgroundColor: info.isOpen ? "rgba(34,197,94,0.22)" : "rgba(239,68,68,0.25)" }]}>
                  <View style={[styles.openDot, { backgroundColor: info.isOpen ? "#4ADE80" : "#F87171" }]} />
                  <Text style={styles.statusText}>{info.isOpen ? "Open now" : "Closed"}</Text>
                </View>
                {hours ? (
                  <Text style={styles.heroMeta} numberOfLines={1}>
                    Today {hours}
                  </Text>
                ) : null}
              </View>
            ) : null}
          </View>
        </View>
      </View>

      <View style={styles.sheet}>
        <Text style={styles.kicker}>{info && !info.isOpen ? "Order ahead for later" : "How would you like it?"}</Text>
        {modes.length ? (
          <View style={styles.modes}>
            {modes.map((m, i) => (
              <Pressable
                key={m.key}
                accessibilityRole="button"
                accessibilityLabel={`${m.title}, ${m.sub}. Open the menu`}
                onPress={() => openMode(m.key)}
                style={({ pressed }) => [
                  styles.mode,
                  i === 0 ? styles.modePrimary : styles.modeSecondary,
                  pressed && { transform: [{ scale: 0.97 }] },
                ]}
              >
                <View style={[styles.modeIcon, { backgroundColor: i === 0 ? "rgba(255,255,255,0.2)" : `${colors.primary}14` }]}>
                  <Ionicons name={m.icon} size={24} color={i === 0 ? "#fff" : colors.primary} />
                </View>
                <Text style={[styles.modeTitle, i === 0 && { color: "#fff" }]}>{m.title}</Text>
                <Text style={[styles.modeMeta, i === 0 && { color: "rgba(255,255,255,0.85)" }]}>{m.sub}</Text>
                <View style={[styles.modeGo, { backgroundColor: i === 0 ? "#fff" : colors.primary }]}>
                  <Ionicons name="arrow-forward" size={16} color={i === 0 ? colors.primary : "#fff"} />
                </View>
              </Pressable>
            ))}
          </View>
        ) : (
          <Button title={info && !info.isOpen ? "Order for later" : "Start your order"} onPress={startOrder} />
        )}

        {latest ? <LatestOrder orderId={latest.orderId} slug={latest.slug} /> : null}

        <AccessBanner />

        {info?.campaign ? (
          <Pressable
            accessibilityRole="button"
            onPress={startOrder}
            style={({ pressed }) => [styles.offer, pressed && { transform: [{ scale: 0.98 }] }]}
          >
            <View style={styles.offerBadge}>
              <Ionicons name="pricetag" size={20} color={colors.primary} />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={styles.offerKicker}>Today's offer</Text>
              <Text style={styles.offerText}>{offerText(info.campaign, currency)}</Text>
            </View>
            <Ionicons name="chevron-forward" size={20} color="#fff" />
          </Pressable>
        ) : null}

        {info?.topSellers?.length ? (
          <View>
            <View style={styles.sectionHead}>
              <Text style={styles.sectionTitle}>Popular right now</Text>
              <Pressable onPress={startOrder} hitSlop={10} accessibilityRole="button">
                <Text style={styles.seeAll}>See menu</Text>
              </Pressable>
            </View>
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={{ gap: 14, paddingHorizontal: 20 }}
              style={{ marginHorizontal: -20 }}
            >
              {info.topSellers.slice(0, 10).map((item) => {
                const img = imageUrl(item.imageUrl);
                return (
                  <Pressable
                    key={item.id}
                    onPress={startOrder}
                    accessibilityRole="button"
                    accessibilityLabel={`${item.name}, ${money(item.basePrice, currency)}`}
                    style={({ pressed }) => [styles.item, pressed && { transform: [{ scale: 0.97 }] }]}
                  >
                    {img ? (
                      <Image source={{ uri: img }} style={styles.itemImage} />
                    ) : (
                      <View style={[styles.itemImage, styles.itemPlaceholder]}>
                        <Ionicons name="restaurant-outline" size={30} color={colors.muted} />
                      </View>
                    )}
                    <View style={styles.itemBody}>
                      <Text style={styles.itemName} numberOfLines={2}>
                        {item.name}
                      </Text>
                      <View style={styles.itemFoot}>
                        <Text style={styles.itemPrice}>{money(item.basePrice, currency)}</Text>
                        <View style={styles.itemAdd}>
                          <Ionicons name="add" size={18} color="#fff" />
                        </View>
                      </View>
                    </View>
                  </Pressable>
                );
              })}
            </ScrollView>
          </View>
        ) : null}

        {!offersAsked ? (
          <View style={styles.panel}>
            <Text style={styles.sectionTitle}>Get our offers first?</Text>
            <Text style={styles.muted}>
              The occasional deal and news from {brand.name}. Order updates come either way.
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
          </View>
        ) : null}

        {findUs ? (
          <View style={styles.panel}>
            <Text style={styles.sectionTitle}>Find us</Text>
            <View style={styles.findRow}>
              <Ionicons name="location-outline" size={18} color={colors.muted} />
              <Text style={[styles.muted, { flex: 1 }]}>{findUs.address}</Text>
            </View>
            {hours ? (
              <View style={styles.findRow}>
                <Ionicons name="time-outline" size={18} color={colors.muted} />
                <Text style={[styles.muted, { flex: 1 }]}>Today {hours}</Text>
              </View>
            ) : null}
            <View style={styles.offerButtons}>
              {findUs.phone ? (
                <IconButton
                  icon="call"
                  label="Call"
                  onPress={() => Linking.openURL(`tel:${findUs.phone!.replace(/\s+/g, "")}`)}
                />
              ) : null}
              <IconButton
                icon="navigate"
                label="Directions"
                onPress={() => {
                  const q = encodeURIComponent(findUs.query);
                  Linking.openURL(
                    Platform.OS === "ios" ? `https://maps.apple.com/?q=${q}` : `https://www.google.com/maps/search/?api=1&query=${q}`,
                  );
                }}
              />
            </View>
          </View>
        ) : null}
      </View>
    </ScrollView>
  );
}

function IconButton({ icon, label, onPress }: { icon: keyof typeof Ionicons.glyphMap; label: string; onPress: () => void }) {
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      style={({ pressed }) => [styles.iconButton, pressed && { opacity: 0.85, transform: [{ scale: 0.97 }] }]}
    >
      <Ionicons name={icon} size={18} color={colors.primary} />
      <Text style={styles.iconButtonText}>{label}</Text>
    </Pressable>
  );
}

function LatestOrder({ orderId, slug }: { orderId: string; slug: string }) {
  const { order } = useOrderStatus(orderId);
  if (!order || isFinished(order.status)) return null;
  return (
    <Pressable
      accessibilityRole="button"
      onPress={() => openOrder(orderId, slug)}
      style={({ pressed }) => [styles.latest, pressed && { transform: [{ scale: 0.98 }] }]}
    >
      <View style={styles.latestIcon}>
        <Ionicons name="receipt" size={20} color="#fff" />
      </View>
      <View style={{ flex: 1, gap: 6 }}>
        <Text style={styles.latestTitle}>Your order {orderLabel(order)}</Text>
        <StatusPill order={order} />
      </View>
      <Text style={styles.latestTrack}>Track</Text>
      <Ionicons name="chevron-forward" size={18} color={colors.primary} />
    </Pressable>
  );
}

const shadow = "0px 6px 20px rgba(17, 24, 39, 0.08)";

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.background },
  hero: { height: 320, overflow: "hidden", paddingHorizontal: 20, justifyContent: "space-between", paddingBottom: 56 },
  heroShade: {
    experimental_backgroundImage: "linear-gradient(180deg, rgba(0,0,0,0.45) 0%, rgba(0,0,0,0.05) 40%, rgba(0,0,0,0.72) 100%)",
  },
  shopChip: {
    alignSelf: "flex-start",
    maxWidth: "85%",
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingLeft: 12,
    paddingRight: 12,
    paddingVertical: 7,
    borderRadius: radius.chip,
    backgroundColor: "rgba(17,24,39,0.55)",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.18)",
  },
  shopChipLabel: { fontSize: 11, fontWeight: "600", color: "rgba(255,255,255,0.75)", letterSpacing: 0.3 },
  shopChipName: { fontSize: 14, fontWeight: "800", color: "#fff" },
  heroFoot: { flexDirection: "row", alignItems: "flex-end", gap: 14, marginTop: "auto" },
  logoWrap: { width: 72, height: 72, borderRadius: 20, backgroundColor: "#fff", padding: 6, boxShadow: "0px 8px 24px rgba(0,0,0,0.3)" },
  logo: { width: "100%", height: "100%", borderRadius: 14 },
  name: { fontSize: 28, fontWeight: "900", color: "#fff", letterSpacing: -0.5 },
  metaRow: { flexDirection: "row", alignItems: "center", gap: 10, marginTop: 6 },
  statusPill: { flexDirection: "row", alignItems: "center", gap: 6, paddingHorizontal: 10, paddingVertical: 4, borderRadius: radius.chip },
  statusText: { fontSize: 13, fontWeight: "800", color: "#fff" },
  openDot: { width: 7, height: 7, borderRadius: 4 },
  heroMeta: { fontSize: 13, fontWeight: "600", color: "rgba(255,255,255,0.88)", flexShrink: 1 },
  sheet: {
    marginTop: -32,
    borderTopLeftRadius: 28,
    borderTopRightRadius: 28,
    backgroundColor: colors.background,
    paddingHorizontal: 20,
    paddingTop: 24,
    gap: 18,
  },
  kicker: { fontSize: 20, fontWeight: "900", color: colors.text, letterSpacing: -0.3, marginBottom: -4 },
  modes: { flexDirection: "row", gap: 12 },
  mode: { flex: 1, borderRadius: 22, padding: 16, minHeight: 150, gap: 4 },
  modePrimary: { backgroundColor: colors.primary, boxShadow: `0px 10px 24px ${colors.primary}55` },
  modeSecondary: { backgroundColor: colors.card, borderWidth: 1, borderColor: colors.border, boxShadow: shadow },
  modeIcon: { width: 46, height: 46, borderRadius: 23, alignItems: "center", justifyContent: "center", marginBottom: 10 },
  modeTitle: { fontSize: 18, fontWeight: "900", color: colors.text },
  modeMeta: { fontSize: 13, fontWeight: "600", color: colors.muted },
  modeGo: { position: "absolute", top: 16, right: 16, width: 30, height: 30, borderRadius: 15, alignItems: "center", justifyContent: "center" },
  latest: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    padding: 14,
    borderRadius: 20,
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: `${colors.primary}33`,
    boxShadow: shadow,
  },
  latestIcon: { width: 42, height: 42, borderRadius: 21, backgroundColor: colors.primary, alignItems: "center", justifyContent: "center" },
  latestTitle: { fontSize: 16, fontWeight: "800", color: colors.text },
  latestTrack: { fontSize: 14, fontWeight: "800", color: colors.primary },
  offer: {
    flexDirection: "row",
    alignItems: "center",
    gap: 14,
    borderRadius: 20,
    padding: 16,
    backgroundColor: colors.text,
    experimental_backgroundImage: `linear-gradient(120deg, ${colors.text} 0%, ${colors.text} 55%, ${colors.primary} 100%)`,
  },
  offerBadge: { width: 44, height: 44, borderRadius: 14, backgroundColor: "#fff", alignItems: "center", justifyContent: "center" },
  offerKicker: { fontSize: 12, fontWeight: "800", color: "rgba(255,255,255,0.7)", textTransform: "uppercase", letterSpacing: 0.8 },
  offerText: { color: "#fff", fontSize: 16, fontWeight: "800", marginTop: 2 },
  sectionHead: { flexDirection: "row", alignItems: "baseline", justifyContent: "space-between" },
  sectionTitle: { fontSize: 19, fontWeight: "900", color: colors.text, letterSpacing: -0.3, marginBottom: 12 },
  seeAll: { fontSize: 14, fontWeight: "800", color: colors.primary },
  muted: { fontSize: 14, color: colors.muted, lineHeight: 20 },
  panel: { backgroundColor: colors.card, borderRadius: 20, padding: 18, boxShadow: shadow },
  findRow: { flexDirection: "row", alignItems: "flex-start", gap: 10, marginBottom: 8 },
  offerButtons: { flexDirection: "row", gap: 10, marginTop: 10 },
  iconButton: {
    flex: 1,
    minHeight: 48,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    borderRadius: 14,
    backgroundColor: `${colors.primary}12`,
  },
  iconButtonText: { fontSize: 15, fontWeight: "800", color: colors.primary },
  item: { width: 168, borderRadius: 20, backgroundColor: colors.card, overflow: "hidden", boxShadow: shadow },
  itemImage: { width: 168, height: 124, backgroundColor: colors.border },
  itemPlaceholder: { alignItems: "center", justifyContent: "center" },
  itemBody: { padding: 12, gap: 8, flex: 1, justifyContent: "space-between" },
  itemName: { fontSize: 14, fontWeight: "800", color: colors.text, lineHeight: 19, minHeight: 38 },
  itemFoot: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  itemPrice: { fontSize: 15, fontWeight: "900", color: colors.text },
  itemAdd: { width: 30, height: 30, borderRadius: 15, backgroundColor: colors.primary, alignItems: "center", justifyContent: "center" },
});
