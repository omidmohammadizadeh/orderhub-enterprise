// "View basket · 3 · £24.97" — springs up from below the screen the first time
// something goes in, and the count pops on every add.

import { useEffect } from "react";
import { StyleSheet, View } from "react-native";
import Animated, { useAnimatedStyle, useSharedValue, withSequence, withSpring, withTiming } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { money } from "@/lib/money";
import { C, F, MOTION, shadow } from "@/theme";
import { PressScale } from "./PressScale";
import { T } from "./T";

export function BasketBar({ count, total, onPress, label = "View basket" }: { count: number; total: number; onPress: () => void; label?: string }) {
  const insets = useSafeAreaInsets();
  const y = useSharedValue(160);
  const pop = useSharedValue(1);
  const visible = count > 0;

  useEffect(() => {
    y.value = visible ? withSpring(0, { damping: 14, stiffness: 190, mass: 0.8 }) : withTiming(160, { duration: 220 });
  }, [visible, y]);
  useEffect(() => {
    if (count > 0) pop.value = withSequence(withTiming(1.35, { duration: 100 }), withSpring(1, MOTION.bouncy));
  }, [count, pop]);

  const barStyle = useAnimatedStyle(() => ({ transform: [{ translateY: y.value }] }));
  const badgeStyle = useAnimatedStyle(() => ({ transform: [{ scale: pop.value }] }));

  return (
    <Animated.View pointerEvents={visible ? "auto" : "none"} style={[styles.wrap, { bottom: Math.max(insets.bottom, 16) + 8 }, barStyle]}>
      <PressScale onPress={onPress} accessibilityLabel={`${label}, ${count} items, ${money(total)}`} style={[styles.bar, shadow.lifted]} scaleTo={0.97} haptic>
        <View style={styles.left}>
          <T style={styles.label}>{label}</T>
          <Animated.View style={[styles.badge, badgeStyle]}>
            <T style={styles.badgeText}>{count}</T>
          </Animated.View>
        </View>
        <View style={styles.total}>
          <T style={styles.totalText}>{money(total)}</T>
        </View>
      </PressScale>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  wrap: { position: "absolute", left: 16, right: 16 },
  bar: {
    height: 58,
    borderRadius: 29,
    backgroundColor: C.ink,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingLeft: 22,
    paddingRight: 8,
  },
  left: { flexDirection: "row", alignItems: "center", gap: 10 },
  label: { fontFamily: F.bold, fontSize: 16, color: C.white },
  badge: { minWidth: 24, height: 24, borderRadius: 12, backgroundColor: C.lime, alignItems: "center", justifyContent: "center", paddingHorizontal: 6 },
  badgeText: { fontFamily: F.heavy, fontSize: 13, color: C.ink },
  total: { height: 42, borderRadius: 21, backgroundColor: C.ink2, justifyContent: "center", paddingHorizontal: 16 },
  totalText: { fontFamily: F.bold, fontSize: 15, color: C.white, fontVariant: ["tabular-nums"] },
});
