// Search — shops and cuisines near the chosen address. Searching dishes across
// every menu needs a server-side search endpoint (README → API gaps); until
// then this matches shop names, areas and cuisines.

import { useEffect, useMemo, useRef, useState } from "react";
import { FlatList, StyleSheet, TextInput, View } from "react-native";
import Animated from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useShops } from "@/api/hooks";
import type { Shop } from "@/api/types";
import { RoundButton } from "@/components/Bits";
import { CUISINES, CuisineIcon } from "@/components/CuisineIcon";
import { Icon } from "@/components/Icon";
import { Photo } from "@/components/Photo";
import { PressScale } from "@/components/PressScale";
import { etaText, feeText, joinDot, kindOf } from "@/components/ShopCards";
import { T } from "@/components/T";
import { fadeUp, stagger } from "@/lib/motion";
import type { RootScreen } from "@/navigation/types";
import { searchPoint, useSelectedAddress } from "@/state/address";
import { C, F } from "@/theme";

export function SearchScreen({ navigation }: RootScreen<"Search">) {
  const insets = useSafeAreaInsets();
  const point = searchPoint(useSelectedAddress());
  const shopsQ = useShops(point);
  const [q, setQ] = useState("");
  const input = useRef<TextInput>(null);

  useEffect(() => {
    const t = setTimeout(() => input.current?.focus(), 250);
    return () => clearTimeout(t);
  }, []);

  const results = useMemo(() => {
    const shops = shopsQ.data ?? [];
    const term = q.trim().toLowerCase();
    if (!term) return shops;
    return shops.filter((s) => `${s.name} ${s.area ?? ""} ${s.cuisines.join(" ")}`.toLowerCase().includes(term));
  }, [shopsQ.data, q]);

  const open = (shop: Shop) => navigation.navigate("Shop", { shop });

  return (
    <View style={[styles.root, { paddingTop: insets.top + 8 }]}>
      <View style={styles.bar}>
        <RoundButton icon="back" label="Back" light onPress={() => navigation.goBack()} />
        <View style={styles.field}>
          <Icon name="search" size={20} />
          <TextInput
            ref={input}
            value={q}
            onChangeText={setQ}
            placeholder="Shops, cuisines, areas"
            placeholderTextColor={C.grey500}
            returnKeyType="search"
            style={styles.input}
            accessibilityLabel="Search shops"
          />
          {q ? (
            <PressScale onPress={() => setQ("")} accessibilityLabel="Clear search">
              <Icon name="close" size={18} />
            </PressScale>
          ) : null}
        </View>
      </View>

      <FlatList
        data={results}
        keyExtractor={(s) => s.id}
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 40, gap: 4 }}
        ListHeaderComponent={
          !q ? (
            <View style={{ gap: 12, paddingVertical: 12 }}>
              <T v="title">Popular cuisines</T>
              <View style={styles.cuisines}>
                {CUISINES.filter((c) => c.kind !== "deal" && c.kind !== "moon").map((c, i) => (
                  <Animated.View key={c.kind} entering={fadeUp(stagger(i, 30, 0), 10, 400)}>
                    <PressScale onPress={() => setQ(c.label === "Fast food" ? "burger" : c.label.replace(/s$/, ""))} style={styles.cuisine}>
                      <CuisineIcon kind={c.kind} size={32} />
                      <T style={styles.cuisineText}>{c.label}</T>
                    </PressScale>
                  </Animated.View>
                ))}
              </View>
              <T v="title" style={{ marginTop: 8 }}>Near {point.label}</T>
            </View>
          ) : (
            <T v="sub" style={{ paddingVertical: 12 }}>{results.length} {results.length === 1 ? "shop" : "shops"}</T>
          )
        }
        ListEmptyComponent={
          shopsQ.isLoading ? <T v="sub">Searching…</T> : <T v="sub">No shops match “{q}”. Try a cuisine, like pizza.</T>
        }
        renderItem={({ item, index }) => (
          <Animated.View entering={fadeUp(stagger(index, 40, 0), 10, 400)}>
            <PressScale onPress={() => open(item)} style={styles.row} scaleTo={0.98}>
              <Photo uri={item.heroImageUrl} kind={kindOf(item)} radius={14} style={{ width: 64, height: 64 }} />
              <View style={{ flex: 1, gap: 2 }}>
                <T v="item">{item.name}</T>
                <T v="sub">{[item.area, item.cuisines.slice(0, 2).join(", ")].filter(Boolean).join(" · ")}</T>
                <T v="sub">{joinDot(feeText(item), etaText(item), !item.isOpen && "Closed")}</T>
              </View>
              <Icon name="chevronRight" size={18} color={C.grey500} />
            </PressScale>
          </Animated.View>
        )}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: C.white },
  bar: { flexDirection: "row", alignItems: "center", gap: 10, paddingHorizontal: 16, paddingBottom: 6 },
  field: { flex: 1, height: 48, borderRadius: 24, backgroundColor: C.grey100, flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 14 },
  input: { flex: 1, fontFamily: F.medium, fontSize: 16, color: C.ink },
  cuisines: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  cuisine: { flexDirection: "row", alignItems: "center", gap: 6, paddingLeft: 6, paddingRight: 12, height: 44, borderRadius: 22, backgroundColor: C.grey100 },
  cuisineText: { fontFamily: F.semibold, fontSize: 14, color: C.ink },
  row: { flexDirection: "row", alignItems: "center", gap: 12, paddingVertical: 10 },
});
