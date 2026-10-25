// The auto-scrolling cuisine row. It drifts left forever (two copies of the
// list, wrapped at the halfway point), every icon bobs on its own beat, and a
// finger on the row stops the drift so an icon can be tapped — it picks up
// again from where it stopped, not from a jump.

import { memo, useEffect } from "react";
import { StyleSheet, View } from "react-native";
import Animated, {
  Easing,
  useAnimatedStyle,
  useFrameCallback,
  useSharedValue,
  withDelay,
  withRepeat,
  withSequence,
  withTiming,
} from "react-native-reanimated";
import { C, F } from "@/theme";
import { CUISINES, CuisineIcon, type CuisineKind } from "./CuisineIcon";
import { PressScale } from "./PressScale";

const ITEM_W = 84;
const SPEED = (CUISINES.length * ITEM_W) / 30; // px per second: one lap in 30s, as designed

const Bobbing = memo(function Bobbing({ kind, index }: { kind: CuisineKind; index: number }) {
  const t = useSharedValue(0);
  useEffect(() => {
    const half = kind === "deal" ? 1200 : 1500;
    t.value = withDelay(
      (index % CUISINES.length) * 270,
      withRepeat(withSequence(withTiming(1, { duration: half, easing: Easing.inOut(Easing.sin) }), withTiming(0, { duration: half, easing: Easing.inOut(Easing.sin) })), -1),
    );
  }, [t, kind, index]);
  const style = useAnimatedStyle(() =>
    kind === "deal"
      ? { transform: [{ rotate: `${-8 + t.value * 16}deg` }, { scale: 1 + t.value * 0.08 }] }
      : { transform: [{ translateY: -3 * t.value }] },
  );
  return (
    <Animated.View style={[styles.iconBox, style]}>
      <CuisineIcon kind={kind} />
    </Animated.View>
  );
});

export function CuisineMarquee({ selected, onPick }: { selected: CuisineKind | null; onPick: (kind: CuisineKind) => void }) {
  const x = useSharedValue(0);
  const paused = useSharedValue(false);
  const lap = CUISINES.length * ITEM_W;

  useFrameCallback((frame) => {
    if (paused.value) return;
    const dt = (frame.timeSincePreviousFrame ?? 16) / 1000;
    x.value = (x.value - SPEED * dt) % lap;
  });

  const rowStyle = useAnimatedStyle(() => ({ transform: [{ translateX: x.value }] }));
  const items = [...CUISINES, ...CUISINES];

  return (
    <View
      style={styles.wrap}
      onTouchStart={() => {
        paused.value = true;
      }}
      onTouchEnd={() => {
        paused.value = false;
      }}
      onTouchCancel={() => {
        paused.value = false;
      }}
    >
      <Animated.View style={[styles.row, { width: lap * 2 }, rowStyle]}>
        {items.map((c, i) => (
          <PressScale
            key={`${c.kind}-${i}`}
            onPress={() => onPick(c.kind)}
            accessibilityLabel={c.label}
            accessibilityState={{ selected: selected === c.kind }}
            style={styles.item}
            scaleTo={0.9}
          >
            <Bobbing kind={c.kind} index={i} />
            <Animated.Text style={[styles.label, selected === c.kind && styles.labelOn]} numberOfLines={1}>
              {c.label}
            </Animated.Text>
          </PressScale>
        ))}
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { overflow: "hidden", paddingTop: 18, paddingBottom: 6 },
  row: { flexDirection: "row" },
  item: { width: ITEM_W, alignItems: "center", gap: 8 },
  iconBox: { width: 64, height: 56, alignItems: "center", justifyContent: "center" },
  label: { fontFamily: F.semibold, fontSize: 13, color: C.ink },
  labelOn: { fontFamily: F.heavy, textDecorationLine: "underline" },
});
