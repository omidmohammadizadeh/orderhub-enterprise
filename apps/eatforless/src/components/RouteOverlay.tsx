// The animated layer over the tracking map: the route (black), the part
// already driven (grey), the shop and home markers, and our own top-down car
// that drives the route and turns at each corner. Everything is positioned in
// screen points, on the UI thread.

import { useEffect, useMemo } from "react";
import { StyleSheet, View } from "react-native";
import Animated, {
  Easing,
  useAnimatedProps,
  useAnimatedStyle,
  useDerivedValue,
  useSharedValue,
  withRepeat,
  withTiming,
  type SharedValue,
} from "react-native-reanimated";
import Svg, { Path, Rect } from "react-native-svg";
import { cumulative, pathD, pointAt, type Pt } from "@/lib/route";
import { C } from "@/theme";
import { Icon } from "./Icon";

const APath = Animated.createAnimatedComponent(Path);

/** The car, nose pointing right (+x). Our own drawing, in the top-down style. */
export function CarArt({ width = 44 }: { width?: number }) {
  return (
    <Svg width={width} height={width / 2} viewBox="0 0 44 22">
      <Rect x={1} y={2} width={42} height={18} rx={7} fill={C.ink} />
      <Rect x={24} y={0} width={4} height={3} rx={1} fill={C.ink} />
      <Rect x={24} y={19} width={4} height={3} rx={1} fill={C.ink} />
      <Rect x={12} y={5} width={14} height={12} rx={2} fill="#1F1F1F" />
      <Path d="M27 4h5c2 0 3 3 3 7s-1 7-3 7h-5c1-2 1.5-4 1.5-7S28 6 27 4z" fill="#56626E" />
      <Path d="M8 5h3c-.8 2-1 4-1 6s.2 4 1 6H8c-1-1.5-1.5-3.5-1.5-6S7 6.5 8 5z" fill="#56626E" />
      <Rect x={40.5} y={4} width={2} height={3} rx={1} fill="#FFF3B0" />
      <Rect x={40.5} y={15} width={2} height={3} rx={1} fill="#FFF3B0" />
    </Svg>
  );
}

function Pulse({ at }: { at: Pt }) {
  const t = useSharedValue(0);
  useEffect(() => {
    t.value = withRepeat(withTiming(1, { duration: 2000, easing: Easing.out(Easing.quad) }), -1);
  }, [t]);
  const ring = useAnimatedStyle(() => ({ opacity: 0.55 * (1 - t.value), transform: [{ scale: 0.5 + t.value * 1.7 }] }));
  return (
    <View pointerEvents="none" style={[styles.homeWrap, { left: at.x - 14, top: at.y - 14 }]}>
      <Animated.View style={[styles.homeRing, ring]} />
      <View style={styles.home} />
    </View>
  );
}

type Props = {
  points: Pt[];
  /** 0–1 along the route. */
  progress: SharedValue<number>;
  showCar: boolean;
  showShop?: boolean;
  showHome?: boolean;
};

export function RouteOverlay({ points, progress, showCar, showShop = true, showHome = true }: Props) {
  const cum = useMemo(() => cumulative(points), [points]);
  const total = cum[cum.length - 1] ?? 0;
  const d = useMemo(() => pathD(points), [points]);
  const pts = useDerivedValue(() => points, [points]);
  const cums = useDerivedValue(() => cum, [cum]);

  const doneProps = useAnimatedProps(() => ({
    strokeDashoffset: total * (1 - progress.value),
  }));
  const carStyle = useAnimatedStyle(() => {
    const p = pointAt(pts.value, cums.value, progress.value);
    return {
      transform: [{ translateX: p.x - 22 }, { translateY: p.y - 11 }, { rotate: `${p.angle}rad` }],
    };
  });

  if (points.length < 2) return null;
  const start = points[0]!;
  const end = points[points.length - 1]!;

  return (
    <View pointerEvents="none" style={StyleSheet.absoluteFill}>
      <Svg style={StyleSheet.absoluteFill}>
        <Path d={d} stroke={C.ink} strokeWidth={6} fill="none" strokeLinecap="round" strokeLinejoin="round" />
        {/* The driven part, drawn back-to-front so it grows from the shop. */}
        <APath
          d={d}
          stroke="#A9A9A9"
          strokeWidth={6}
          fill="none"
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeDasharray={[total, total]}
          animatedProps={doneProps}
        />
      </Svg>
      {showShop ? (
        <View style={[styles.shop, { left: start.x - 18, top: start.y - 40 }]}>
          <Icon name="cutlery" size={18} color={C.lime} />
        </View>
      ) : null}
      {showHome ? <Pulse at={end} /> : null}
      {showCar ? (
        <Animated.View style={[styles.car, carStyle]}>
          <CarArt />
        </Animated.View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  shop: {
    position: "absolute",
    width: 36,
    height: 36,
    borderRadius: 10,
    backgroundColor: C.ink,
    alignItems: "center",
    justifyContent: "center",
    shadowColor: "#000",
    shadowOpacity: 0.25,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 4 },
  },
  homeWrap: { position: "absolute", width: 28, height: 28 },
  homeRing: { position: "absolute", width: 28, height: 28, borderRadius: 14, backgroundColor: C.ink },
  home: { position: "absolute", left: 4, top: 4, width: 20, height: 20, borderRadius: 10, backgroundColor: C.white, borderWidth: 6, borderColor: C.ink },
  car: {
    position: "absolute",
    left: 0,
    top: 0,
    width: 44,
    height: 22,
    shadowColor: "#000",
    shadowOpacity: 0.35,
    shadowRadius: 4,
    shadowOffset: { width: 0, height: 3 },
  },
});
