// Small shared pieces: the wordmark, the round icon button, the
// deal badge, the stepper, section headers and a shimmer skeleton.

import { useEffect, useRef, type ReactNode } from "react";
import { StyleSheet, View, type StyleProp, type ViewStyle } from "react-native";
import Animated, {
  Easing,
  interpolate,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withSpring,
  withSequence,
  withTiming,
} from "react-native-reanimated";
import { C, F, MOTION, shadow } from "@/theme";
import { Icon, type IconName } from "./Icon";
import { PressScale } from "./PressScale";
import { T } from "./T";

/**
 * The brand: "eat for" with "less" on a lime tag — the same wordmark as the
 * welcome screen and the app icon. `size` is the font size; "light" is for
 * dark backgrounds.
 */
export function Wordmark({
  size = 20,
  tone = "dark",
  style,
}: {
  size?: number;
  tone?: "dark" | "light";
  style?: StyleProp<ViewStyle>;
}) {
  const word = { fontFamily: F.display, fontSize: size, letterSpacing: -size * 0.04, color: tone === "light" ? C.white : C.ink };
  return (
    <View
      style={[{ flexDirection: "row", alignItems: "center" }, style]}
      accessible
      accessibilityRole="image"
      accessibilityLabel="Eat For Less"
    >
      <T style={word}>eat for </T>
      <View style={{ backgroundColor: C.lime, borderRadius: size * 0.2, paddingHorizontal: size * 0.12 }}>
        <T style={[word, { color: C.ink }]}>less</T>
      </View>
    </View>
  );
}

export function RoundButton({
  icon,
  onPress,
  label,
  style,
  light,
  children,
}: {
  icon?: IconName;
  onPress?: () => void;
  label: string;
  style?: ViewStyle;
  light?: boolean;
  children?: ReactNode;
}) {
  return (
    <PressScale
      onPress={onPress}
      accessibilityLabel={label}
      style={[styles.round, light ? styles.roundLight : [styles.roundWhite, shadow.soft], style]}
    >
      {children ?? (icon ? <Icon name={icon} size={20} /> : null)}
    </PressScale>
  );
}

export function DealBadge({ text, style }: { text: string; style?: StyleProp<ViewStyle> }) {
  return (
    <View style={[styles.deal, style]}>
      <T style={styles.dealText}>{text}</T>
    </View>
  );
}

export function SectionHeader({ title, sub, onMore }: { title: string; sub?: string; onMore?: () => void }) {
  return (
    <View style={styles.sectionHeader}>
      <View style={{ flex: 1, gap: 2 }}>
        <T v="h2">{title}</T>
        {sub ? <T v="sub" style={{ textDecorationLine: "underline" }}>{sub}</T> : null}
      </View>
      {onMore ? <RoundButton icon="arrowRight" label={`See all ${title}`} onPress={onMore} light style={{ width: 40, height: 40 }} /> : null}
    </View>
  );
}

/** − 2 + with the number popping on change, as in the Item artboard. */
export function Stepper({
  value,
  onChange,
  min = 1,
  compact,
  canAdd = true,
}: {
  value: number;
  /** `delta` is what this tap changed, for callers that store a difference. */
  onChange: (next: number, delta: number) => void;
  min?: number;
  compact?: boolean;
  /** false greys the + (the tap still reaches onChange, so the caller can say why). */
  canAdd?: boolean;
}) {
  // Taps faster than a re-render would otherwise each read the same stale
  // `value`, so the second tap of a quick double-tap was lost.
  const latest = useRef(value);
  latest.current = value;
  const step = (delta: number) => {
    const next = Math.max(min, latest.current + delta);
    if (next === latest.current) return;
    const changed = next - latest.current;
    latest.current = next;
    onChange(next, changed);
  };

  const pop = useSharedValue(1);
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    pop.value = withSequence(withTiming(1.18, { duration: 80 }), withSpring(1, MOTION.press));
  }, [value, pop]);
  const numStyle = useAnimatedStyle(() => ({ transform: [{ scale: pop.value }] }));
  const h = compact ? 40 : 52;
  const btn = compact ? 36 : 44;
  return (
    <View style={[styles.stepper, { height: h, borderRadius: h / 2 }]}>
      <PressScale
        accessibilityLabel={value <= 1 && min === 0 ? "Remove" : "Fewer"}
        onPress={() => step(-1)}
        style={[styles.stepBtn, { width: btn, height: btn, borderRadius: btn / 2 }]}
        hitSlop={8}
        scaleTo={0.88}
        haptic
      >
        <Icon name={value <= 1 && min === 0 ? "trash" : "minus"} size={compact ? 16 : 18} />
      </PressScale>
      {/* Fixed width: 9 → 10 used to widen the pill and slide + out from under the finger. */}
      <Animated.Text style={[styles.stepNum, compact && { fontSize: 15, width: 22 }, numStyle]}>{value}</Animated.Text>
      <PressScale
        accessibilityLabel="More"
        onPress={() => step(1)}
        style={[styles.stepBtn, { width: btn, height: btn, borderRadius: btn / 2 }]}
        hitSlop={8}
        scaleTo={0.88}
        haptic
      >
        <Icon name="plus" size={compact ? 16 : 18} color={canAdd ? undefined : C.grey400} />
      </PressScale>
    </View>
  );
}

/** Grey placeholder with a light sweeping across it while data loads. */
export function Shimmer({ style }: { style?: ViewStyle }) {
  const t = useSharedValue(0);
  useEffect(() => {
    t.value = withRepeat(withTiming(1, { duration: 1300, easing: Easing.inOut(Easing.quad) }), -1, false);
  }, [t]);
  const sweep = useAnimatedStyle(() => ({
    transform: [{ translateX: interpolate(t.value, [0, 1], [-200, 400]) }],
  }));
  return (
    <View style={[{ backgroundColor: C.grey100, overflow: "hidden" }, style]}>
      <Animated.View style={[StyleSheet.absoluteFill, { width: 120, backgroundColor: "rgba(255,255,255,0.55)" }, sweep]} />
    </View>
  );
}

const styles = StyleSheet.create({
  round: { width: 44, height: 44, borderRadius: 22, alignItems: "center", justifyContent: "center" },
  roundWhite: { backgroundColor: C.white },
  roundLight: { backgroundColor: C.grey100 },
  deal: { backgroundColor: C.ink, borderRadius: 8, paddingHorizontal: 8, paddingVertical: 5, alignSelf: "flex-start" },
  dealText: { color: C.lime, fontFamily: F.heavy, fontSize: 11 },
  sectionHeader: { paddingHorizontal: 16, flexDirection: "row", alignItems: "flex-start", justifyContent: "space-between" },
  stepper: { flexDirection: "row", alignItems: "center", backgroundColor: C.grey100, paddingHorizontal: 4, gap: 4 },
  stepBtn: { width: 44, height: 44, borderRadius: 22, alignItems: "center", justifyContent: "center" },
  stepNum: { width: 26, textAlign: "center", fontFamily: F.heavy, fontSize: 17, color: C.ink, fontVariant: ["tabular-nums"] },
});
