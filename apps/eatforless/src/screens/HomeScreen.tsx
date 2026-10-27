// 2 · Home — Uber Eats order: address + bell, top pills, the cuisine marquee,
// filter chips, Featured, Top brands, Order again, the banner, Deals to
// explore and All shops. Paid placements arrive marked (shop.sponsored, first
// in the list); the cards label them and report taps — see ShopCards.

import { useNavigation } from "@react-navigation/native";
import { useCallback, useMemo, useState } from "react";
import { RefreshControl, ScrollView, StyleSheet, View } from "react-native";
import Animated, { useAnimatedStyle, useSharedValue, withRepeat, withSequence, withTiming, Easing } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useEffect } from "react";
import { useMyOrders, useShops } from "@/api/hooks";
import type { Shop } from "@/api/types";
import { RoundButton, SectionHeader, Shimmer, TagMark } from "@/components/Bits";
import { CUISINES, type CuisineKind } from "@/components/CuisineIcon";
import { CuisineMarquee } from "@/components/CuisineMarquee";
import { Icon } from "@/components/Icon";
import { PressScale } from "@/components/PressScale";
import { AgainCard, DealCard, FeaturedCard, ListCard, etaMin } from "@/components/ShopCards";
import { T } from "@/components/T";
import { MOCK } from "@/config";
import { fadeUp } from "@/lib/motion";
import { searchPoint, useSelectedAddress } from "@/state/address";
import { C, F, shadow } from "@/theme";

const TOPS = ["All", "Takeaway", "Grocery", "Desserts", "Late night"] as const;
const FILTERS = ["Pickup", "Offers", "Delivery under £2", "Under 30 min", "Rating 4.5+"] as const;
type Filter = (typeof FILTERS)[number];

function applyFilters(shops: Shop[], top: (typeof TOPS)[number], cuisine: CuisineKind | null, on: Set<Filter>) {
  return shops.filter((s) => {
    const text = `${s.cuisines.join(" ")} ${s.name}`;
    if (top === "Desserts" && !/dessert|sweet|ice/i.test(text)) return false;
    if (cuisine && cuisine !== "deal" && cuisine !== "moon") {
      const c = CUISINES.find((x) => x.kind === cuisine);
      if (c && !c.match.test(text)) return false;
    }
    if (cuisine === "deal" && !s.deal) return false;
    if (on.has("Pickup") && !s.collection.available) return false;
    if (on.has("Offers") && !s.deal) return false;
    if (on.has("Delivery under £2") && !(s.delivery.available && (s.delivery.fee ?? 0) < 2)) return false;
    if (on.has("Under 30 min") && !((etaMin(s) ?? 99) < 30)) return false;
    if (on.has("Rating 4.5+") && !((s.rating?.value ?? 0) >= 4.5)) return false;
    return true;
  });
}

function Wobble() {
  const t = useSharedValue(0);
  useEffect(() => {
    t.value = withRepeat(
      withSequence(withTiming(1, { duration: 1200, easing: Easing.inOut(Easing.sin) }), withTiming(0, { duration: 1200, easing: Easing.inOut(Easing.sin) })),
      -1,
    );
  }, [t]);
  const style = useAnimatedStyle(() => ({ transform: [{ rotate: `${-8 + 16 * t.value}deg` }, { scale: 1 + 0.08 * t.value }] }));
  return (
    <Animated.View style={style}>
      <TagMark size={92} />
    </Animated.View>
  );
}

export function HomeScreen() {
  const nav = useNavigation();
  const insets = useSafeAreaInsets();
  const address = useSelectedAddress();
  const point = searchPoint(address);
  const shopsQ = useShops(point);
  const ordersQ = useMyOrders();
  const [top, setTop] = useState<(typeof TOPS)[number]>("All");
  const [cuisine, setCuisine] = useState<CuisineKind | null>(null);
  const [filters, setFilters] = useState<Set<Filter>>(new Set());

  const shops = shopsQ.data ?? [];
  // Stable so the memoised cards don't re-render on every filter tap.
  const open = useCallback((shop: Shop) => nav.navigate("Shop", { shop }), [nav]);
  const filtered = useMemo(() => applyFilters(shops, top, cuisine, filters), [shops, top, cuisine, filters]);
  const filtering = top !== "All" || cuisine !== null || filters.size > 0;

  // Featured, Top brands and Deals are drawn from the nearby-shops list. The
  // API puts sponsored shops first, so they lead Featured when open; only
  // those carry the Sponsored label — the sections themselves aren't ads.
  const featured = useMemo(() => shops.filter((s) => s.isOpen).slice(0, 6), [shops]);
  const brands = useMemo(() => [...shops].sort((a, b) => (b.rating?.count ?? 0) - (a.rating?.count ?? 0)).slice(0, 8), [shops]);
  const deals = useMemo(() => {
    const withDeal = shops.filter((s) => s.deal && s.isOpen);
    return (withDeal.length ? withDeal : [...shops].reverse()).slice(0, 5);
  }, [shops]);

  const again = useMemo(() => {
    const ids = [...new Set((ordersQ.data ?? []).map((o) => o.location?.eflListing?.id).filter(Boolean))] as string[];
    return ids.map((id) => shops.find((s) => s.id === id)).filter((s): s is Shop => !!s);
  }, [ordersQ.data, shops]);

  const toggleFilter = (f: Filter) =>
    setFilters((prev) => {
      const next = new Set(prev);
      if (next.has(f)) next.delete(f);
      else next.add(f);
      return next;
    });

  let section = 0;
  const enter = () => fadeUp(80 + section++ * 50);

  return (
    <View style={styles.root}>
      <ScrollView
        contentContainerStyle={{ paddingTop: insets.top + 8, paddingBottom: 140 }}
        showsVerticalScrollIndicator={false}
        refreshControl={<RefreshControl refreshing={shopsQ.isRefetching} onRefresh={() => shopsQ.refetch()} tintColor={C.ink} />}
      >
        <View style={styles.header}>
          <PressScale onPress={() => nav.navigate("Address")} accessibilityLabel={`Delivering to ${point.label}. Change address`} style={styles.addressBtn}>
            <T style={styles.address} numberOfLines={1}>{address ? address.line1 : "Set your address"}</T>
            <Icon name="chevronDown" size={16} />
          </PressScale>
          <RoundButton icon="bell" label="Notifications" light style={{ backgroundColor: "transparent" }}>
            <Icon name="bell" size={24} />
            <View style={styles.bellDot} />
          </RoundButton>
        </View>

        <Animated.View entering={enter()}>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chipsRow}>
            {TOPS.map((t) => {
              const on = t === top;
              return (
                <PressScale key={t} onPress={() => setTop(t)} accessibilityState={{ selected: on }} style={[styles.topPill, on && styles.topPillOn]}>
                  <T style={[styles.topText, on && { color: C.white }]}>{t}</T>
                </PressScale>
              );
            })}
          </ScrollView>
        </Animated.View>

        <Animated.View entering={enter()}>
          <CuisineMarquee selected={cuisine} onPick={(k) => setCuisine((c) => (c === k ? null : k))} />
        </Animated.View>

        <Animated.View entering={enter()}>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={[styles.chipsRow, { paddingTop: 8 }]}>
            {FILTERS.map((f) => {
              const on = filters.has(f);
              return (
                <PressScale key={f} onPress={() => toggleFilter(f)} accessibilityState={{ selected: on }} style={[styles.filter, on && styles.filterOn]}>
                  <T style={[styles.filterText, on && { color: C.white }]}>{f}</T>
                </PressScale>
              );
            })}
          </ScrollView>
        </Animated.View>

        {shopsQ.isLoading ? (
          <Loading />
        ) : shopsQ.isError ? (
          <Empty title="Couldn't load shops" body={(shopsQ.error as Error).message} action="Try again" onAction={() => shopsQ.refetch()} />
        ) : shops.length === 0 ? (
          <Empty
            title="No shops here yet"
            body={`Eat For Less is starting in Newcastle and Tyne and Wear. We'll let you know when shops near ${point.label} join.`}
            action="Change address"
            onAction={() => nav.navigate("Address")}
          />
        ) : filtering ? (
          <View style={styles.allShops}>
            <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
              <T v="h2">{filtered.length} {filtered.length === 1 ? "shop" : "shops"}</T>
              <PressScale onPress={() => { setTop("All"); setCuisine(null); setFilters(new Set()); }} style={styles.reset}>
                <T v="label">Reset</T>
              </PressScale>
            </View>
            {filtered.map((s, i) => (
              <Animated.View key={s.id} entering={fadeUp(i * 50)}>
                <ListCard shop={s} onPress={open} />
              </Animated.View>
            ))}
            {filtered.length === 0 ? <T v="sub">Nothing matches those filters. Try removing one.</T> : null}
          </View>
        ) : (
          <>
            <Animated.View entering={enter()} style={{ paddingTop: 26 }}>
              <SectionHeader title="Featured on Eat For Less" onMore={() => nav.navigate("Search")} />
              <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ paddingHorizontal: 16, paddingTop: 12 }}>
                <View style={styles.grid2}>
                  {pairs(featured).map((col, i) => (
                    <View key={i} style={{ gap: 12 }}>
                      {col.map((s) => <FeaturedCard key={s.id} shop={s} onPress={open} />)}
                    </View>
                  ))}
                </View>
              </ScrollView>
            </Animated.View>

            <Animated.View entering={enter()} style={{ paddingTop: 28 }}>
              <T v="h2" style={{ marginHorizontal: 16 }}>Top brands near you</T>
              <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.brands}>
                {brands.map((b, i) => (
                  <PressScale key={b.id} onPress={() => open(b)} accessibilityLabel={b.name} style={styles.brand} scaleTo={0.92}>
                    <View style={[styles.brandCircle, { backgroundColor: BRAND_BG[i % BRAND_BG.length]![0] }]}>
                      <T style={[styles.brandMark, { color: BRAND_BG[i % BRAND_BG.length]![1] }]}>{initials(b.name)}</T>
                    </View>
                    <T style={styles.brandName} numberOfLines={2}>{b.name}</T>
                    {etaMin(b) != null ? <T style={styles.brandTime}>{etaMin(b)} min</T> : null}
                  </PressScale>
                ))}
              </ScrollView>
            </Animated.View>

            {again.length > 0 ? (
              <Animated.View entering={enter()} style={{ paddingTop: 28 }}>
                <T v="h2" style={{ marginHorizontal: 16 }}>Order again</T>
                <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.hRow}>
                  {again.map((s) => <AgainCard key={s.id} shop={s} onPress={open} />)}
                </ScrollView>
              </Animated.View>
            ) : null}

            <Animated.View entering={enter()} style={styles.banner}>
              <View style={{ flex: 1, gap: 8 }}>
                <T style={styles.bannerTitle}>{"Same menu.\nLower prices."}</T>
                <T style={styles.bannerSub}>Shops pay us less, so you pay less.</T>
                <PressScale onPress={() => nav.navigate("Search")} style={styles.bannerBtn}>
                  <T style={styles.bannerBtnText}>See offers</T>
                </PressScale>
              </View>
              <Wobble />
            </Animated.View>

            <Animated.View entering={enter()} style={{ paddingTop: 28 }}>
              <SectionHeader title="Deals to explore" />
              <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.hRow}>
                {deals.map((s) => <DealCard key={s.id} shop={s} onPress={open} />)}
              </ScrollView>
            </Animated.View>

            <Animated.View entering={enter()} style={styles.allShops}>
              <T v="h2">All shops</T>
              {shops.map((s) => (
                <ListCard key={s.id} shop={s} onPress={open} />
              ))}
            </Animated.View>
          </>
        )}
        {MOCK ? <T v="small" style={styles.mockNote}>Sample data — EXPO_PUBLIC_EFL_MOCK=1</T> : null}
      </ScrollView>
      {/* Keeps the status bar readable over scrolled content. */}
      <View pointerEvents="none" style={[styles.statusVeil, { height: insets.top }]} />
    </View>
  );
}

const BRAND_BG: Array<[string, string]> = [
  ["#C9432A", C.white],
  ["#F2C238", C.ink],
  [C.ink, C.lime],
  ["#2F6B3A", C.white],
  [C.grey100, C.ink],
];

function initials(name: string) {
  return name
    .split(/\s+/)
    .filter((w) => /^[A-Za-z]/.test(w))
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join("");
}

function pairs<T>(list: T[]): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < list.length; i += 2) out.push(list.slice(i, i + 2));
  return out;
}

function Loading() {
  return (
    <View style={{ padding: 16, gap: 14, paddingTop: 26 }}>
      <Shimmer style={{ width: 220, height: 24, borderRadius: 8 }} />
      <View style={{ flexDirection: "row", gap: 12 }}>
        <Shimmer style={{ width: 196, height: 180, borderRadius: 16 }} />
        <Shimmer style={{ width: 196, height: 180, borderRadius: 16 }} />
      </View>
      <Shimmer style={{ height: 176, borderRadius: 18 }} />
      <Shimmer style={{ width: 180, height: 16, borderRadius: 6 }} />
    </View>
  );
}

function Empty({ title, body, action, onAction }: { title: string; body: string; action: string; onAction: () => void }) {
  return (
    <Animated.View entering={fadeUp(100)} style={styles.empty}>
      <TagMark size={56} />
      <T v="h3" style={{ textAlign: "center" }}>{title}</T>
      <T v="sub" style={{ textAlign: "center", fontSize: 15, lineHeight: 21 }}>{body}</T>
      <PressScale onPress={onAction} style={styles.emptyBtn}>
        <T style={{ color: C.white, fontFamily: F.bold, fontSize: 15 }}>{action}</T>
      </PressScale>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: C.white },
  header: { paddingHorizontal: 16, flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  addressBtn: { flexDirection: "row", alignItems: "center", gap: 6, flexShrink: 1, paddingVertical: 8 },
  address: { fontFamily: F.displayBold, fontSize: 19, color: C.ink, flexShrink: 1 },
  bellDot: { position: "absolute", top: 9, right: 10, width: 11, height: 11, borderRadius: 6, backgroundColor: C.lime, borderWidth: 2, borderColor: C.white },
  chipsRow: { gap: 8, paddingHorizontal: 16, paddingTop: 10 },
  topPill: { height: 40, borderRadius: 20, paddingHorizontal: 16, justifyContent: "center", borderWidth: 1.5, borderColor: C.grey300, backgroundColor: C.white },
  topPillOn: { backgroundColor: C.ink, borderColor: C.ink },
  topText: { fontFamily: F.bold, fontSize: 14, color: C.ink },
  filter: { height: 38, borderRadius: 19, paddingHorizontal: 14, justifyContent: "center", backgroundColor: C.grey100 },
  filterOn: { backgroundColor: C.ink },
  filterText: { fontFamily: F.semibold, fontSize: 14, color: C.ink },
  grid2: { flexDirection: "row", gap: 12 },
  brands: { gap: 14, paddingHorizontal: 16, paddingTop: 14 },
  brand: { width: 72, alignItems: "center", gap: 6 },
  brandCircle: { width: 68, height: 68, borderRadius: 34, alignItems: "center", justifyContent: "center", borderWidth: 1, borderColor: C.border },
  brandMark: { fontFamily: F.display, fontSize: 20 },
  brandName: { fontFamily: F.semibold, fontSize: 12, textAlign: "center", lineHeight: 14, color: C.ink },
  brandTime: { fontFamily: F.regular, fontSize: 11, color: C.grey500 },
  hRow: { gap: 12, paddingHorizontal: 16, paddingTop: 12 },
  banner: {
    marginTop: 28,
    marginHorizontal: 16,
    borderRadius: 20,
    backgroundColor: C.ink,
    padding: 20,
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    overflow: "hidden",
  },
  bannerTitle: { fontFamily: F.display, fontSize: 21, lineHeight: 23, letterSpacing: -0.4, color: C.white },
  bannerSub: { fontFamily: F.regular, fontSize: 12, color: "#C9C9C9" },
  bannerBtn: { alignSelf: "flex-start", backgroundColor: C.lime, borderRadius: 16, paddingHorizontal: 14, paddingVertical: 8 },
  bannerBtnText: { fontFamily: F.bold, fontSize: 13, color: C.ink },
  allShops: { paddingTop: 30, paddingHorizontal: 16, gap: 18 },
  reset: { paddingHorizontal: 14, height: 36, borderRadius: 18, backgroundColor: C.grey100, justifyContent: "center" },
  empty: { alignItems: "center", gap: 12, paddingHorizontal: 32, paddingTop: 48 },
  emptyBtn: { marginTop: 8, height: 48, borderRadius: 24, backgroundColor: C.ink, paddingHorizontal: 24, justifyContent: "center", ...shadow.soft },
  statusVeil: { position: "absolute", top: 0, left: 0, right: 0, backgroundColor: C.white },
  mockNote: { textAlign: "center", marginTop: 24, color: C.grey400 },
});
