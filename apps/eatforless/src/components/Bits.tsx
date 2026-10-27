// Small shared pieces: the lime price-tag mark, the round icon button, the
// deal badge, the stepper, section headers and a shimmer skeleton.

import { useEffect, type ReactNode } from "react";
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

/** The brand mark: a lime tag with a tight top-left corner and a £. */
export function TagMark({ size = 36, style }: { size?: number; style?: ViewStyle }) {
  return (
    <View
      style={[
        {
          width: size,
          height: size,
          backgroundColor: C.lime,
          borderTopLeftRadius: size * 0.27,
          borderTopRightRadius: size * 0.5,
          borderBottomLeftRadius: size * 0.5,
          borderBottomRightRadius: size * 0.5,
          alignItems: "center",
          justifyContent: "center",
        },
        style,
      ]}
    >
      <T style={{ fontFamily: F.display, fontSize: size * 0.5, color: C.ink, lineHeight: size * 0.62 }}>£</T>
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
}: {
  value: number;
  onChange: (next: number) => void;
  min?: number;
  compact?: boolean;
}) {
  const pop = useSharedValue(1);
  useEffect(() => {
    pop.value = withSequence(withTiming(1.4, { duration: 90 }), withSpring(1, MOTION.bouncy));
  }, [value, pop]);
  const numStyle = useAnimatedStyle(() => ({ transform: [{ scale: pop.value }] }));
  const h = compact ? 36 : 52;
  return (
    <View style={[styles.stepper, { height: h, borderRadius: h / 2 }]}>
      <PressScale
        accessibilityLabel={value <= min && min === 0 ? "Remove" : "Fewer"}
        onPress={() => onChange(Math.max(min, value - 1))}
        style={[styles.stepBtn, compact && { width: 32, height: 32 }]}
        haptic
      >
        <Icon name={value <= 1 && min === 0 ? "trash" : "minus"} size={compact ? 15 : 18} />
      </PressScale>
      <Animated.Text style={[styles.stepNum, compact && { fontSize: 14 }, numStyle]}>{value}</Animated.Text>
      <PressScale accessibilityLabel="More" onPress={() => onChange(value + 1)} style={[styles.stepBtn, compact && { width: 32, height: 32 }]} haptic>
        <Icon name="plus" size={compact ? 15 : 18} />
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
  stepNum: { minWidth: 18, textAlign: "center", fontFamily: F.heavy, fontSize: 17, color: C.ink, fontVariant: ["tabular-nums"] },
});
