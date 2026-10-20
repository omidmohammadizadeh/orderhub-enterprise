import { useEffect, useRef } from "react";
import {
  Animated,
  Easing,
  LayoutChangeEvent,
  PanResponder,
  Platform,
  StyleSheet,
  Text,
  Vibration,
  View,
} from "react-native";
import { C } from "@/theme";
import { Icon, IconName } from "@/components/ui";

const H = 64;
const KNOB = H - 8;

// Slide-to-confirm: drag the knob ~85% across to fire. The track fills with the
// action colour behind the knob so progress is obvious at arm's length.
export function SlideToConfirm({
  label,
  color,
  icon = "arrow-forward",
  onConfirm,
}: {
  label: string;
  color: string;
  icon?: IconName;
  onConfirm: () => void;
}) {
  const widthRef = useRef(0);
  const x = useRef(new Animated.Value(0)).current;
  const shimmer = useRef(new Animated.Value(0)).current;

  // The PanResponder is built once, so it must read the CURRENT handler. The
  // three steps (start → arrived → delivered) render this same component in the
  // same slot; holding the first closure would replay "start" on every slide.
  const confirmRef = useRef(onConfirm);
  confirmRef.current = onConfirm;

  useEffect(() => {
    const loop = Animated.loop(
      Animated.timing(shimmer, { toValue: 1, duration: 2200, easing: Easing.linear, useNativeDriver: true }),
    );
    loop.start();
    return () => loop.stop();
  }, [shimmer]);

  const pan = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      // Never let a parent (the stop pager's swipe) steal a slide half-way.
      onPanResponderTerminationRequest: () => false,
      onPanResponderMove: (_e, g) => {
        const max = Math.max(0, widthRef.current - KNOB - 8);
        x.setValue(Math.min(Math.max(0, g.dx), max));
      },
      onPanResponderRelease: (_e, g) => {
        const max = Math.max(0, widthRef.current - KNOB - 8);
        if (max > 0 && g.dx >= max * 0.85) {
          if (Platform.OS === "android") Vibration.vibrate(25);
          Animated.timing(x, { toValue: max, duration: 110, useNativeDriver: false }).start(() => {
            confirmRef.current();
            Animated.timing(x, { toValue: 0, duration: 240, useNativeDriver: false }).start();
          });
        } else {
          Animated.spring(x, { toValue: 0, useNativeDriver: false, bounciness: 6 }).start();
        }
      },
    }),
  ).current;

  const labelOpacity = x.interpolate({ inputRange: [0, 140], outputRange: [1, 0.15], extrapolate: "clamp" });

  return (
    <View
      style={[styles.track, { borderColor: color }]}
      onLayout={(e: LayoutChangeEvent) => {
        widthRef.current = e.nativeEvent.layout.width;
      }}
    >
      <Animated.View
        style={[styles.fill, { backgroundColor: color, width: Animated.add(x, KNOB + 8) }]}
        pointerEvents="none"
      />
      <Animated.Text style={[styles.label, { opacity: labelOpacity }]} numberOfLines={1}>
        {label}
      </Animated.Text>
      <Animated.View
        pointerEvents="none"
        style={[
          styles.shine,
          {
            transform: [
              { translateX: shimmer.interpolate({ inputRange: [0, 1], outputRange: [-80, 420] }) },
              { skewX: "-20deg" },
            ],
          },
        ]}
      />
      <Animated.View style={[styles.knob, { transform: [{ translateX: x }] }]} {...pan.panHandlers}>
        <Icon name={icon} size={26} color={color} />
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  track: {
    height: H,
    borderRadius: H / 2,
    borderWidth: 1.5,
    backgroundColor: C.surface2,
    justifyContent: "center",
    alignItems: "center",
    overflow: "hidden",
  },
  fill: { position: "absolute", left: 0, top: 0, bottom: 0, borderRadius: H / 2, opacity: 0.9 },
  label: { color: C.text, fontSize: 17, fontWeight: "800", letterSpacing: 0.3, paddingLeft: KNOB },
  shine: {
    position: "absolute",
    top: 0,
    bottom: 0,
    width: 60,
    backgroundColor: "rgba(255,255,255,0.06)",
  },
  knob: {
    position: "absolute",
    left: 3,
    width: KNOB,
    height: KNOB,
    borderRadius: KNOB / 2,
    backgroundColor: "#fff",
    alignItems: "center",
    justifyContent: "center",
  },
});

// Same height as the slider, for the spinner shown while an action is in
// flight — so the sheet never jumps.
export function SliderSpacer({ children }: { children?: React.ReactNode }) {
  return <View style={{ height: H, alignItems: "center", justifyContent: "center" }}>{children}</View>;
}
