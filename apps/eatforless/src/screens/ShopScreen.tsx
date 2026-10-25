// 3 · Shop — collapsing hero, the shop's sheet sliding up over it, sticky
// category tabs with the animated underline and scroll-spy, quick add, and the
// basket bar springing up.

import { useEffect, useMemo, useRef, useState } from "react";
import { Alert, StyleSheet, View, useWindowDimensions } from "react-native";
import * as Haptics from "expo-haptics";
import Animated, {
  Extrapolation,
  interpolate,
  runOnJS,
  useAnimatedRef,
  useAnimatedScrollHandler,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withSpring,
  withTiming,
  Easing,
  scrollTo,
} from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useShopMenu } from "@/api/hooks";
import type { MenuItem, Shop } from "@/api/types";
import { BasketBar } from "@/components/BasketBar";
import { RoundButton, Shimmer, TagMark } from "@/components/Bits";
import { CategoryTabs, TABS_HEIGHT } from "@/components/CategoryTabs";
import { FoodArt } from "@/components/FoodArt";
import { Icon } from "@/components/Icon";
import { Photo } from "@/components/Photo";
import { PressScale } from "@/components/PressScale";
import { etaText, feeText, kindOf } from "@/components/ShopCards";
import { T } from "@/components/T";
import { fadeUp, stagger } from "@/lib/motion";
import { foodKind, isOrderable, menuSections, needsOptions, priceLabel, type MenuSection } from "@/lib/menu";
import { money, toNumber } from "@/lib/money";
import type { RootScreen } from "@/navigation/types";
import { basketCount, basketSubtotal, useBasket } from "@/state/basket";
import { useFavourites } from "@/state/favourites";
import { C, F, MOTION, shadow } from "@/theme";

const HERO_H = 250;

function HeroArt({ uri, kind }: { uri: string | null; kind: ReturnType<typeof foodKind> }) {
  const intro = useSharedValue(0);
  const spin = useSharedValue(0);
  useEffect(() => {
    intro.value = withTiming(1, { duration: 1000, easing: Easing.bezier(0.2, 0.8, 0.2, 1) });
    if (!uri && kind === "pizza") spin.value = withRepeat(withTiming(1, { duration: 40000, easing: Easing.linear }), -1);
  }, [intro, spin, uri, kind]);
  const style = useAnimatedStyle(() => ({
    opacity: 0.4 + intro.value * 0.6,
    transform: [
      { scale: 1.12 - intro.value * 0.12 },
      { rotate: `${(uri || kind !== "pizza" ? 0 : -6 * (1 - intro.value)) + spin.value * 360}deg` },
    ],
  }));
  if (uri) {
    return (
      <Animated.View style={[StyleSheet.absoluteFill, style]}>
        <Photo uri={uri} kind={kind} style={StyleSheet.absoluteFillObject} />
      </Animated.View>
    );
  }
  if (kind !== "pizza") {
    return (
      <Animated.View style={[StyleSheet.absoluteFill, style]}>
        <FoodArt kind={kind} style={StyleSheet.absoluteFillObject} />
      </Animated.View>
    );
  }
  // No photo: the design's slowly turning pizza.
  return (
    <View style={[StyleSheet.absoluteFill, { backgroundColor: "#F5E6D6", overflow: "hidden" }]}>
      <Animated.View style={[{ position: "absolute", width: 360, height: 360, left: 90, top: -60 }, style]}>
        <FoodArt kind={kind} style={{ width: 360, height: 360, backgroundColor: "transparent" }} />
      </Animated.View>
    </View>
  );
}

function ItemRow({
  item,
  index,
  qty,
  onOpen,
  onAdd,
}: {
  item: MenuItem;
  index: number;
  qty: number;
  onOpen: () => void;
  onAdd: () => void;
}) {
  const orderable = isOrderable(item);
  const bump = useSharedValue(1);
  useEffect(() => {
    if (qty > 0) bump.value = withSpring(1, { ...MOTION.bouncy, velocity: 8 });
  }, [qty, bump]);
  const btnStyle = useAnimatedStyle(() => ({ transform: [{ scale: bump.value }] }));
  return (
    <Animated.View entering={fadeUp(stagger(index, 70, 80), 14, 600)}>
      <PressScale onPress={onOpen} disabled={!orderable} scaleTo={0.98} style={[styles.row, !orderable && { opacity: 0.45 }]} accessibilityLabel={`${item.name}, ${priceLabel(item)}`}>
        <View style={{ flex: 1, gap: 5, minWidth: 0 }}>
          <T v="item">{item.name}</T>
          {item.description ? <T v="sub" numberOfLines={2}>{item.description.replace(/\s*\n\s*/g, " · ")}</T> : null}
          <T v="price" style={{ marginTop: 2 }}>{orderable ? priceLabel(item) : "Sold out"}</T>
        </View>
        <View style={styles.thumbWrap}>
          <Photo uri={item.imageUrl} kind={foodKind(item.name)} radius={14} style={styles.thumb} />
          {orderable ? (
            <Animated.View style={[styles.plusWrap, btnStyle]}>
              <PressScale
                onPress={() => {
                  bump.value = 0.85;
                  onAdd();
                }}
                accessibilityLabel={`Add ${item.name}`}
                scaleTo={0.85}
                style={[styles.plus, qty > 0 && styles.plusOn, shadow.soft]}
              >
                {qty > 0 ? <T style={styles.plusCount}>{qty}</T> : <Icon name="plus" size={16} />}
              </PressScale>
            </Animated.View>
          ) : null}
        </View>
      </PressScale>
    </Animated.View>
  );
}

export function ShopScreen({ navigation, route }: RootScreen<"Shop">) {
  const { shop } = route.params;
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const menuQ = useShopMenu(shop.id);
  const basket = useBasket();
  const fav = useFavourites((s) => s.ids.includes(shop.id));
  const toggleFav = useFavourites((s) => s.toggle);

  const scrollRef = useAnimatedRef<Animated.ScrollView>();
  const scrollY = useSharedValue(0);
  const tabsY = useSharedValue(10_000);
  const sectionYs = useRef<number[]>([]);
  const sectionYsShared = useSharedValue<number[]>([]);
  const [active, setActive] = useState(0);
  const jumping = useSharedValue(false);

  const store = menuQ.data?.store;
  const sections: MenuSection[] = useMemo(() => (store ? menuSections(store, "DELIVERY") : []), [store]);
  const heroUri = menuQ.data?.listing.heroImageUrl ?? shop.heroImageUrl ?? null;
  const headerH = insets.top + 52;

  const qtyByItem = useMemo(() => {
    const m: Record<string, number> = {};
    if (basket.shop?.id === shop.id) for (const l of basket.lines) m[l.menuItemId] = (m[l.menuItemId] ?? 0) + l.quantity;
    return m;
  }, [basket.lines, basket.shop?.id, shop.id]);

  const onScroll = useAnimatedScrollHandler({
    onScroll: (e) => {
      scrollY.value = e.contentOffset.y;
      if (jumping.value) return;
      const ys = sectionYsShared.value;
      const probe = e.contentOffset.y + headerH + TABS_HEIGHT + 24;
      let idx = 0;
      for (let i = 0; i < ys.length; i++) if (ys[i]! <= probe) idx = i;
      runOnJS(setActiveIfChanged)(idx);
    },
    onMomentumEnd: () => {
      jumping.value = false;
    },
  });

  function setActiveIfChanged(i: number) {
    setActive((cur) => (cur === i ? cur : i));
  }

  const jumpTo = (i: number) => {
    const y = sectionYs.current[i];
    if (y == null) return;
    setActive(i);
    jumping.value = true;
    scrollRef.current?.scrollTo({ y: Math.max(0, y - headerH - TABS_HEIGHT + 1), animated: true });
    setTimeout(() => {
      jumping.value = false;
    }, 700);
  };

  // Hero: parallax on the way up, stretch on pull-down.
  const heroStyle = useAnimatedStyle(() => {
    const y = scrollY.value;
    return {
      transform: [
        { translateY: y < 0 ? y / 2 : -y * 0.45 },
        { scale: y < 0 ? 1 + -y / HERO_H : 1 },
      ],
    };
  });
  // The compact white bar with the shop's name fades in as the hero leaves.
  const barStyle = useAnimatedStyle(() => ({
    opacity: interpolate(scrollY.value, [HERO_H - headerH - 60, HERO_H - headerH], [0, 1], Extrapolation.CLAMP),
  }));
  const titleStyle = useAnimatedStyle(() => ({
    opacity: interpolate(scrollY.value, [HERO_H - 20, HERO_H + 30], [0, 1], Extrapolation.CLAMP),
    transform: [{ translateY: interpolate(scrollY.value, [HERO_H - 20, HERO_H + 30], [8, 0], Extrapolation.CLAMP) }],
  }));
  // Tabs scroll with the page until they meet the bar, then stick under it.
  const tabsStyle = useAnimatedStyle(() => ({
    transform: [{ translateY: Math.max(headerH, tabsY.value - scrollY.value) }],
    shadowOpacity: tabsY.value - scrollY.value <= headerH ? 0.08 : 0,
  }));

  const add = (item: MenuItem) => {
    if (needsOptions(item)) {
      navigation.navigate("Item", { shop, itemId: item.id });
      return;
    }
    const sku = item.productSkus?.length === 1 ? item.productSkus[0]! : null;
    const line = {
      menuItemId: item.id,
      name: item.name,
      imageUrl: item.imageUrl ?? null,
      unitPrice: sku ? sku.price : toNumber(item.basePrice),
      quantity: 1,
      modifiers: [],
      sku: sku ? { name: sku.name, plu: sku.plu } : null,
    };
    const basketShop = { id: shop.id, name: shop.name, area: shop.area };
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    if (!basket.add(basketShop, line)) {
      Alert.alert("Start a new basket?", `Your basket has food from ${basket.shop?.name}. Clear it and add this instead?`, [
        { text: "Keep it", style: "cancel" },
        { text: "New basket", style: "destructive", onPress: () => basket.replaceWith(basketShop, line) },
      ]);
    }
  };

  const minimum = store?.directConfig?.minOrderForDelivery;
  const pills = [
    etaText(shop),
    feeText(shop),
    minimum ? `${money(minimum)} minimum` : null,
    store ? (store.isOpen && !store.closed ? "Open now" : "Closed now") : null,
  ].filter(Boolean) as string[];
  const inBasket = basket.shop?.id === shop.id;

  return (
    <View style={styles.root}>
      <Animated.View style={[styles.hero, heroStyle]}>
        <HeroArt uri={heroUri} kind={kindOf(shop)} />
      </Animated.View>

      <Animated.ScrollView
        ref={scrollRef}
        onScroll={onScroll}
        scrollEventThrottle={16}
        showsVerticalScrollIndicator={false}
        contentContainerStyle={{ paddingTop: HERO_H - 24, paddingBottom: 140 }}
      >
        <Animated.View entering={fadeUp(120, 40, 700)} style={styles.sheet}>
          <View style={{ gap: 6 }}>
            <T v="hero">{shop.name}</T>
            <T v="sub" style={{ fontSize: 14 }}>
              {[shop.area, ...shop.cuisines.slice(0, 2)].filter(Boolean).join(" · ")}
              {shop.rating ? <T style={{ fontFamily: F.semibold, color: C.ink, fontSize: 14 }}>{` · ★ ${shop.rating.value.toFixed(1)}`}</T> : null}
              {shop.rating ? ` (${shop.rating.count})` : ""}
            </T>
          </View>
          <Animated.ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8 }}>
            {pills.map((p) => (
              <View key={p} style={styles.infoPill}>
                <T style={styles.infoText}>{p}</T>
              </View>
            ))}
          </Animated.ScrollView>
          <View style={styles.eflBanner}>
            <TagMark size={36} />
            <T style={styles.eflText}>
              Eat For Less prices on this menu. <T style={{ color: C.lime, fontFamily: F.bold, fontSize: 13 }}>Lower than the big apps.</T>
            </T>
          </View>
          {store && (!store.isOpen || store.closed) ? (
            <View style={styles.closed}>
              <Icon name="clock" size={18} />
              <T v="sub" style={{ flex: 1, color: C.ink }}>
                {store.closed?.reason ?? "This shop is closed right now. You can look at the menu, and order when it opens."}
              </T>
            </View>
          ) : null}
        </Animated.View>

        <View
          style={{ height: TABS_HEIGHT, marginTop: 10 }}
          onLayout={(e) => {
            tabsY.value = e.nativeEvent.layout.y;
          }}
        />

        {menuQ.isLoading ? (
          <View style={{ padding: 16, gap: 16 }}>
            {[0, 1, 2, 3].map((i) => (
              <View key={i} style={{ flexDirection: "row", gap: 14 }}>
                <View style={{ flex: 1, gap: 8 }}>
                  <Shimmer style={{ height: 18, width: "60%", borderRadius: 6 }} />
                  <Shimmer style={{ height: 14, width: "90%", borderRadius: 6 }} />
                  <Shimmer style={{ height: 14, width: "30%", borderRadius: 6 }} />
                </View>
                <Shimmer style={{ width: 100, height: 100, borderRadius: 14 }} />
              </View>
            ))}
          </View>
        ) : menuQ.isError ? (
          <View style={{ padding: 24, gap: 12, alignItems: "center" }}>
            <T v="title">Couldn't load the menu</T>
            <T v="sub" style={{ textAlign: "center" }}>{(menuQ.error as Error).message}</T>
            <PressScale onPress={() => menuQ.refetch()} style={styles.retry}>
              <T style={{ color: C.white, fontFamily: F.bold }}>Try again</T>
            </PressScale>
          </View>
        ) : (
          sections.map((section, si) => (
            <View
              key={section.id}
              style={styles.section}
              onLayout={(e) => {
                sectionYs.current[si] = e.nativeEvent.layout.y;
                sectionYsShared.value = [...sectionYs.current];
              }}
            >
              <T v="h3" style={{ marginBottom: 6 }}>{section.title}</T>
              {section.items.map((item, i) => (
                <ItemRow
                  key={item.id}
                  item={item}
                  index={si === 0 ? i : 0}
                  qty={qtyByItem[item.id] ?? 0}
                  onOpen={() => navigation.navigate("Item", { shop, itemId: item.id })}
                  onAdd={() => add(item)}
                />
              ))}
            </View>
          ))
        )}
      </Animated.ScrollView>

      {sections.length > 0 ? (
        <Animated.View style={[styles.tabs, { width }, tabsStyle]}>
          <CategoryTabs titles={sections.map((s) => s.title)} active={active} onPick={jumpTo} />
        </Animated.View>
      ) : null}

      <Animated.View pointerEvents="none" style={[styles.bar, { height: headerH }, barStyle]} />
      <View style={[styles.topRow, { top: insets.top + 4 }]}>
        <RoundButton icon="back" label="Back" onPress={() => navigation.goBack()} />
        <Animated.Text numberOfLines={1} style={[styles.barTitle, titleStyle]}>{shop.name}</Animated.Text>
        <FavButton on={fav} onPress={() => toggleFav(shop.id)} />
      </View>

      <BasketBar
        count={inBasket ? basketCount(basket.lines) : 0}
        total={inBasket ? basketSubtotal(basket.lines) : 0}
        onPress={() => navigation.navigate("Checkout")}
      />
    </View>
  );
}

function FavButton({ on, onPress }: { on: boolean; onPress: () => void }) {
  const s = useSharedValue(1);
  const style = useAnimatedStyle(() => ({ transform: [{ scale: s.value }] }));
  return (
    <RoundButton
      label={on ? "Remove from saved shops" : "Save shop"}
      onPress={() => {
        s.value = 1.35;
        s.value = withSpring(on ? 1 : 1.15, MOTION.bouncy);
        void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
        onPress();
      }}
    >
      <Animated.View style={style}>
        <Icon name="heart" size={20} fill={on ? C.ink : "none"} />
      </Animated.View>
    </RoundButton>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: C.white },
  hero: { position: "absolute", top: 0, left: 0, right: 0, height: HERO_H, overflow: "hidden", backgroundColor: "#F5E6D6" },
  sheet: {
    backgroundColor: C.white,
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    paddingTop: 22,
    paddingHorizontal: 16,
    gap: 14,
  },
  infoPill: { backgroundColor: C.grey100, borderRadius: 16, paddingHorizontal: 12, paddingVertical: 9 },
  infoText: { fontFamily: F.semibold, fontSize: 13, color: C.ink },
  eflBanner: { flexDirection: "row", alignItems: "center", gap: 12, backgroundColor: C.ink, borderRadius: 16, padding: 14 },
  eflText: { flex: 1, fontFamily: F.regular, fontSize: 13, lineHeight: 18, color: C.white },
  closed: { flexDirection: "row", gap: 10, alignItems: "center", backgroundColor: C.grey100, borderRadius: 14, padding: 12 },
  tabs: {
    position: "absolute",
    top: 0,
    left: 0,
    shadowColor: "#000",
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 4 },
  },
  section: { paddingTop: 18, paddingHorizontal: 16 },
  row: { flexDirection: "row", gap: 14, paddingVertical: 16, borderBottomWidth: 1, borderBottomColor: C.line, alignItems: "center" },
  thumbWrap: { width: 100, height: 100 },
  thumb: { width: 100, height: 100 },
  plusWrap: { position: "absolute", right: 6, bottom: 6 },
  plus: { minWidth: 34, height: 34, borderRadius: 17, backgroundColor: C.white, alignItems: "center", justifyContent: "center", paddingHorizontal: 10 },
  plusOn: { backgroundColor: C.ink },
  plusCount: { fontFamily: F.heavy, fontSize: 14, color: C.lime },
  bar: { position: "absolute", top: 0, left: 0, right: 0, backgroundColor: C.white },
  topRow: { position: "absolute", left: 16, right: 16, flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 12 },
  barTitle: { flex: 1, textAlign: "center", fontFamily: F.display, fontSize: 17, color: C.ink },
  retry: { height: 44, borderRadius: 22, backgroundColor: C.ink, paddingHorizontal: 22, justifyContent: "center" },
});
