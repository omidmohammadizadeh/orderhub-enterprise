import { useRef } from "react";
import {
  Animated,
  LayoutChangeEvent,
  PanResponder,
  StyleSheet,
  Text,
  View,
} from "react-native";

const KNOB = 54;

// OrderLord-style "slide to confirm" pill. Drag the knob ~85% across to fire.
export function SlideToConfirm({
  label,
  color,
  onConfirm,
}: {
  label: string;
  color: string;
  onConfirm: () => void;
}) {
  const widthRef = useRef(0);
  const x = useRef(new Animated.Value(0)).current;

  const pan = useRef(
    PanResponder.create({
      onMoveShouldSetPanResponder: () => true,
      onPanResponderMove: (_e, g) => {
        const max = Math.max(0, widthRef.current - KNOB - 6);
        x.setValue(Math.min(Math.max(0, g.dx), max));
      },
      onPanResponderRelease: (_e, g) => {
        const max = Math.max(0, widthRef.current - KNOB - 6);
        if (g.dx >= max * 0.85) {
          Animated.timing(x, { toValue: max, duration: 120, useNativeDriver: false }).start(() => {
            onConfirm();
            Animated.timing(x, { toValue: 0, duration: 220, useNativeDriver: false }).start();
          });
        } else {
          Animated.spring(x, { toValue: 0, useNativeDriver: false }).start();
        }
      },
    }),
  ).current;

  return (
    <View
      style={[styles.track, { backgroundColor: color }]}
      onLayout={(e: LayoutChangeEvent) => {
        widthRef.current = e.nativeEvent.layout.width;
      }}
    >
      <Text style={styles.label}>{label}</Text>
      <Animated.View style={[styles.knob, { transform: [{ translateX: x }] }]} {...pan.panHandlers}>
        <Text style={[styles.chev, { color }]}>›››</Text>
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  track: {
    height: KNOB + 6,
    borderRadius: (KNOB + 6) / 2,
    justifyContent: "center",
    alignItems: "center",
    overflow: "hidden",
  },
  label: { color: "#fff", fontSize: 17, fontWeight: "700" },
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
  chev: { fontSize: 20, fontWeight: "800" },
});
