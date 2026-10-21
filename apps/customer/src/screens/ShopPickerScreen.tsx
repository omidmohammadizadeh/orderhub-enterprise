import { Ionicons } from "@expo/vector-icons";
import { useCallback, useEffect, useMemo, useState } from "react";
import { ActivityIndicator, FlatList, Pressable, RefreshControl, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { brand } from "../brand";
import { Button } from "../components/Button";
import { navigationRef } from "../navigation";
import { registerOnLaunch } from "../push";
import { type Shop, chooseShop, currentShop, fetchShops, milesBetween } from "../shop";
import { colors, radius } from "../theme";

type Position = { lat: number; lng: number };
type LocationState = "asking" | "granted" | "denied" | "unavailable";

/**
 * Where the customer is, or why we don't know. expo-location is loaded here
 * and nowhere else: only multi-shop builds include its native module, and an
 * over-the-air update reaching a single-shop build must never touch it.
 */
async function locate(): Promise<{ state: LocationState; position: Position | null }> {
  try {
    const Location = await import("expo-location");
    const { status } = await Location.requestForegroundPermissionsAsync();
    if (status !== "granted") return { state: "denied", position: null };
    const last = await Location.getLastKnownPositionAsync({ maxAge: 10 * 60_000 }).catch(() => null);
    const fix =
      last ??
      (await Promise.race([
        Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced }),
        new Promise<null>((r) => setTimeout(() => r(null), 8000)),
      ]).catch(() => null));
    if (!fix) return { state: "granted", position: null };
    return { state: "granted", position: { lat: fix.coords.latitude, lng: fix.coords.longitude } };
  } catch {
    return { state: "unavailable", position: null };
  }
}

/** Pick the shop to order from: nearest first when we know where they are. */
export function ShopPickerScreen() {
  const insets = useSafeAreaInsets();
  const [shops, setShops] = useState<Shop[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [where, setWhere] = useState<{ state: LocationState; position: Position | null }>({
    state: "asking",
    position: null,
  });
  const chosenBefore = currentShop();

  const loadShops = useCallback(async () => {
    try {
      setFailed(false);
      setShops(await fetchShops());
    } catch {
      setFailed(true);
    }
  }, []);

  const askLocation = useCallback(async () => {
    setWhere((w) => ({ ...w, state: "asking" }));
    setWhere(await locate());
  }, []);

  useEffect(() => {
    loadShops();
    askLocation();
  }, [loadShops, askLocation]);

  const sorted = useMemo(() => {
    if (!shops) return null;
    const withDistance = shops.map((s) => ({
      shop: s,
      miles: where.position && s.lat != null && s.lng != null ? milesBetween(where.position, { lat: s.lat, lng: s.lng }) : null,
    }));
    return withDistance.sort((a, b) => {
      if (a.miles != null && b.miles != null) return a.miles - b.miles;
      if (a.miles != null) return -1;
      if (b.miles != null) return 1;
      return a.shop.name.localeCompare(b.shop.name);
    });
  }, [shops, where.position]);

  const pick = async (shop: Shop) => {
    await chooseShop(shop);
    // Push installs are filed under the shop, so tell the server which one.
    registerOnLaunch();
    if (chosenBefore && navigationRef.canGoBack()) navigationRef.goBack();
    else navigationRef.reset({ index: 0, routes: [{ name: "Tabs" }] });
  };

  const refresh = async () => {
    setRefreshing(true);
    await Promise.all([loadShops(), askLocation()]);
    setRefreshing(false);
  };

  return (
    <View style={[styles.root, { paddingTop: chosenBefore ? 0 : insets.top + 12 }]}>
      {!chosenBefore ? (
        <View style={styles.header}>
          <Text style={styles.title}>Choose your {brand.name}</Text>
          <Text style={styles.subtitle}>Pick the shop you want to order from. You can change it any time.</Text>
        </View>
      ) : null}

      {where.state === "denied" || where.state === "unavailable" ? (
        <View style={styles.notice}>
          <Ionicons name="location-outline" size={18} color={colors.muted} />
          <Text style={styles.noticeText}>
            {where.state === "denied"
              ? "Allow location to see the nearest shop first."
              : "Your location isn't available, so shops are in name order."}
          </Text>
          {where.state === "denied" ? (
            <Pressable onPress={askLocation} hitSlop={8}>
              <Text style={styles.link}>Try again</Text>
            </Pressable>
          ) : null}
        </View>
      ) : null}

      {failed ? (
        <View style={styles.center}>
          <Ionicons name="cloud-offline-outline" size={40} color={colors.muted} />
          <Text style={styles.failTitle}>Can't load the shops</Text>
          <Button title="Try again" onPress={loadShops} style={{ marginTop: 16, alignSelf: "stretch" }} />
        </View>
      ) : !sorted ? (
        <View style={styles.center}>
          <ActivityIndicator color={colors.primary} />
        </View>
      ) : (
        <FlatList
          data={sorted}
          keyExtractor={(x) => x.shop.locationId}
          contentContainerStyle={{ padding: 16, paddingBottom: insets.bottom + 24, gap: 12 }}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refresh} />}
          ListHeaderComponent={
            where.state === "asking" ? (
              <Text style={styles.finding}>Finding the shop nearest to you…</Text>
            ) : null
          }
          ListEmptyComponent={<Text style={styles.empty}>No shops are taking orders in the app yet.</Text>}
          renderItem={({ item, index }) => {
            const { shop, miles } = item;
            const selected = chosenBefore?.locationId === shop.locationId;
            return (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`${shop.name}${miles != null ? `, ${miles.toFixed(1)} miles away` : ""}`}
                onPress={() => pick(shop)}
                style={({ pressed }) => [styles.card, selected && styles.cardSelected, pressed && { opacity: 0.85 }]}
              >
                <View style={{ flex: 1 }}>
                  <View style={styles.row}>
                    <Text style={styles.name} numberOfLines={1}>
                      {shop.name}
                    </Text>
                    {index === 0 && miles != null ? <Text style={styles.nearest}>Nearest</Text> : null}
                  </View>
                  {shop.address || shop.postcode ? (
                    <Text style={styles.address} numberOfLines={2}>
                      {[shop.address, shop.postcode].filter(Boolean).join(", ")}
                    </Text>
                  ) : null}
                  <View style={[styles.row, { marginTop: 6 }]}>
                    <View style={[styles.dot, { backgroundColor: shop.isOpen ? colors.success : colors.danger }]} />
                    <Text style={styles.meta}>{shop.isOpen ? "Open now" : "Closed"}</Text>
                    {miles != null ? <Text style={styles.meta}> · {miles < 0.1 ? "Nearby" : `${miles.toFixed(1)} mi`}</Text> : null}
                  </View>
                </View>
                <Ionicons
                  name={selected ? "checkmark-circle" : "chevron-forward"}
                  size={22}
                  color={selected ? colors.primary : colors.muted}
                />
              </Pressable>
            );
          }}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.background },
  header: { paddingHorizontal: 20, paddingBottom: 8 },
  title: { fontSize: 26, fontWeight: "800", color: colors.text },
  subtitle: { fontSize: 15, color: colors.muted, marginTop: 6 },
  notice: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    marginHorizontal: 16,
    marginTop: 12,
    padding: 12,
    borderRadius: radius.button,
    backgroundColor: colors.card,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
  },
  noticeText: { flex: 1, fontSize: 14, color: colors.muted },
  link: { fontSize: 14, fontWeight: "700", color: colors.primary },
  finding: { fontSize: 14, color: colors.muted, marginBottom: 4 },
  center: { flex: 1, alignItems: "center", justifyContent: "center", padding: 32 },
  failTitle: { fontSize: 17, fontWeight: "700", color: colors.text, marginTop: 12 },
  empty: { textAlign: "center", color: colors.muted, marginTop: 40 },
  card: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    padding: 16,
    borderRadius: radius.card,
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.border,
  },
  cardSelected: { borderColor: colors.primary, borderWidth: 2 },
  row: { flexDirection: "row", alignItems: "center", gap: 8 },
  name: { flexShrink: 1, fontSize: 17, fontWeight: "700", color: colors.text },
  nearest: {
    fontSize: 11,
    fontWeight: "700",
    color: colors.onPrimary,
    backgroundColor: colors.primary,
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: radius.chip,
    overflow: "hidden",
  },
  address: { fontSize: 14, color: colors.muted, marginTop: 4 },
  dot: { width: 8, height: 8, borderRadius: 4 },
  meta: { fontSize: 13, color: colors.muted },
});
