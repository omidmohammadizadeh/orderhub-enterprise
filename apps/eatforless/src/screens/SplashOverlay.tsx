// 1 · Splash — plays once over the app while fonts, the session and the first
// shops load, then lifts away. The native splash is the same ink background,
// so the hand-over is seamless.

import { useEffect, useState } from "react";
import { StyleSheet, View } from "react-native";
import Animated, {
  Easing,
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withDelay,
  withTiming,
} from "react-native-reanimated";
import { C, F } from "@/theme";

const RISE = Easing.bezier(0.2, 0.9, 0.2, 1);
const MIN_SHOW_MS = 1900;

function Word({ text, delay, ink }: { text: string; delay: number; ink?: boolean }) {
  const p = useSharedValue(0);
  useEffect(() => {
    p.value = withDelay(delay, withTiming(1, { duration: 700, easing: RISE }));
  }, [p, delay]);
  const style = useAnimatedStyle(() => ({
    opacity: p.value,
    transform: [{ translateY: (1 - p.value) * 40 }, { scale: 0.96 + p.value * 0.04 }],
  }));
  return <Animated.Text style={[styles.word, ink && { color: C.ink, paddingHorizontal: 2 }, style]}>{text}</Animated.Text>;
}

export function SplashOverlay({ ready, onDone }: { ready: boolean; onDone: () => void }) {
  const sweep = useSharedValue(0);
  const sub = useSharedValue(0);
  const bar = useSharedValue(0);
  const exit = useSharedValue(0);
  const [minElapsed, setMinElapsed] = useState(false);

  useEffect(() => {
    sweep.value = withDelay(480, withTiming(1, { duration: 620, easing: Easing.bezier(0.7, 0, 0.2, 1) }));
    sub.value = withDelay(1150, withTiming(1, { duration: 500 }));
    bar.value = withDelay(700, withTiming(0.8, { duration: 1400, easing: Easing.bezier(0.6, 0, 0.2, 1) }));
    const t = setTimeout(() => setMinElapsed(true), MIN_SHOW_MS);
    return () => clearTimeout(t);
  }, [sweep, sub, bar]);

  useEffect(() => {
    if (!ready || !minElapsed) return;
    bar.value = withTiming(1, { duration: 220 });
    exit.value = withDelay(
      200,
      withTiming(1, { duration: 420, easing: Easing.bezier(0.4, 0, 0.2, 1) }, (finished) => {
        if (finished) runOnJS(onDone)();
      }),
    );
  }, [ready, minElapsed, bar, exit, onDone]);

  const sweepStyle = useAnimatedStyle(() => ({ transform: [{ scaleX: sweep.value }] }));
  const subStyle = useAnimatedStyle(() => ({ opacity: sub.value, transform: [{ translateY: (1 - sub.value) * 8 }] }));
  const barStyle = useAnimatedStyle(() => ({ transform: [{ scaleX: bar.value }] }));
  const rootStyle = useAnimatedStyle(() => ({
    opacity: 1 - exit.value,
    transform: [{ scale: 1 + exit.value * 0.06 }],
  }));

  return (
    <Animated.View style={[StyleSheet.absoluteFill, styles.root, rootStyle]} pointerEvents="none">
      <View>
        <Word text="eat" delay={0} />
        <Word text="for" delay={90} />
        <View style={{ alignSelf: "flex-start" }}>
          <Animated.View style={[styles.sweep, sweepStyle]} />
          <Word text="less" delay={180} ink />
        </View>
      </View>
      <Animated.Text style={[styles.sub, subStyle]}>{"Your local favourites.\nFairer prices."}</Animated.Text>
      <View style={styles.track}>
        <Animated.View style={[styles.fill, barStyle]} />
      </View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  root: { backgroundColor: C.ink, alignItems: "center", justifyContent: "center", zIndex: 100 },
  word: { fontFamily: F.display, fontSize: 64, lineHeight: 60, letterSpacing: -2.9, color: C.white },
  sweep: {
    position: "absolute",
    left: -6,
    right: -10,
    top: 8,
    bottom: 0,
    backgroundColor: C.lime,
    borderRadius: 8,
    transformOrigin: "left center",
  },
  sub: { marginTop: 28, fontFamily: F.regular, fontSize: 15, lineHeight: 21, color: "#BDBDBD", textAlign: "center" },
  track: { position: "absolute", bottom: 72, width: 120, height: 3, borderRadius: 2, backgroundColor: C.ink2, overflow: "hidden" },
  fill: { width: "100%", height: "100%", backgroundColor: C.lime, transformOrigin: "left center" },
});
