// The floating bottom bar from the Home artboard: Home, Orders, a Search pill,
// Basket and Account as separate white pills over a white fade.

import type { BottomTabBarProps } from "@react-navigation/bottom-tabs";
import { useNavigation } from "@react-navigation/native";
import { LinearGradient } from "expo-linear-gradient";
import { useEffect } from "react";
import { StyleSheet, View } from "react-native";
import Animated, {
  interpolateColor,
  useAnimatedStyle,
  useDerivedValue,
  useSharedValue,
  withSequence,
  withSpring,
  withTiming,
} from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { basketCount, useBasket } from "@/state/basket";
import { C, F, MOTION, shadow } from "@/theme";
import { Icon, type IconName } from "./Icon";
import { PressScale } from "./PressScale";
import { T } from "./T";

function TabPill({ icon, active, label, onPress }: { icon: IconName; active: boolean; label: string; onPress: () => void }) {
  const on = useDerivedValue(() => withTiming(active ? 1 : 0, { duration: 220 }), [active]);
  const bg = useAnimatedStyle(() => ({ backgroundColor: interpolateColor(on.value, [0, 1], [C.white, C.ink]) }));
  return (
    <PressScale onPress={onPress} accessibilityLabel={label} accessibilityState={{ selected: active }} haptic style={[styles.pill, shadow.card]}>
      <Animated.View style={[StyleSheet.absoluteFill, { borderRadius: 26 }, bg]} />
      <Icon name={icon} color={active ? C.white : C.ink} />
    </PressScale>
  );
}

export function FloatingBar({ state, navigation }: BottomTabBarProps) {
  const insets = useSafeAreaInsets();
  const root = useNavigation();
  const count = useBasket((s) => basketCount(s.lines));
  const bump = useSharedValue(1);
  useEffect(() => {
    if (count > 0) bump.value = withSequence(withTiming(1.35, { duration: 110 }), withSpring(1, MOTION.bouncy));
  }, [count, bump]);
  const badgeStyle = useAnimatedStyle(() => ({ transform: [{ scale: bump.value }] }));

  const current = state.routes[state.index]?.name;
  const go = (name: "Home" | "Orders" | "Account") => {
    if (current !== name) navigation.navigate(name);
  };

  return (
    <View pointerEvents="box-none" style={[styles.wrap, { paddingBottom: Math.max(insets.bottom - 6, 12) }]}>
      <LinearGradient
        pointerEvents="none"
        colors={["rgba(255,255,255,0)", "rgba(255,255,255,0.92)", C.white]}
        locations={[0, 0.45, 1]}
        style={StyleSheet.absoluteFill}
      />
      <TabPill icon="home" label="Home" active={current === "Home"} onPress={() => go("Home")} />
      <TabPill icon="receipt" label="Orders" active={current === "Orders"} onPress={() => go("Orders")} />
      <PressScale
        onPress={() => root.navigate("Search")}
        accessibilityLabel="Search shops or dishes"
        style={[styles.search, shadow.card]}
      >
        <Icon name="search" size={20} />
        <T style={styles.searchText}>Search</T>
      </PressScale>
      <PressScale onPress={() => root.navigate("Checkout")} accessibilityLabel={`Basket, ${count} items`} style={[styles.pill, shadow.card]}>
        <Icon name="basket" />
        {count > 0 ? (
          <Animated.View style={[styles.badge, badgeStyle]}>
            <T style={styles.badgeText}>{count}</T>
          </Animated.View>
        ) : null}
      </PressScale>
      <TabPill icon="user" label="Account" active={current === "Account"} onPress={() => go("Account")} />
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    paddingTop: 22,
    paddingHorizontal: 12,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  pill: { width: 52, height: 52, borderRadius: 26, backgroundColor: C.white, alignItems: "center", justifyContent: "center" },
  search: {
    flex: 1,
    height: 52,
    borderRadius: 26,
    backgroundColor: C.white,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
  },
  searchText: { fontFamily: F.medium, fontSize: 16, color: C.ink },
  badge: {
    position: "absolute",
    top: 4,
    right: 2,
    minWidth: 20,
    height: 20,
    borderRadius: 10,
    paddingHorizontal: 5,
    backgroundColor: C.lime,
    borderWidth: 2,
    borderColor: C.white,
    alignItems: "center",
    justifyContent: "center",
  },
  badgeText: { fontFamily: F.heavy, fontSize: 11, color: C.ink },
});
