import { useEffect, useRef } from "react";
import { Animated, StyleSheet, Text, View } from "react-native";
import { C, R, shadow } from "@/theme";
import { Icon } from "@/components/ui";

// Drops in from the top when dispatch sends a new stop while the app is open,
// then slides away by itself. `count` > 0 shows it; onDone resets the count.
export function NewJobBanner({ count, onDone }: { count: number; onDone: () => void }) {
  const y = useRef(new Animated.Value(-140)).current;
  const doneRef = useRef(onDone);
  doneRef.current = onDone;

  useEffect(() => {
    if (count <= 0) return;
    y.setValue(-140);
    const anim = Animated.sequence([
      Animated.spring(y, { toValue: 0, useNativeDriver: true, bounciness: 8 }),
      Animated.delay(3500),
      Animated.timing(y, { toValue: -140, duration: 260, useNativeDriver: true }),
    ]);
    anim.start(({ finished }) => finished && doneRef.current());
    return () => anim.stop();
  }, [count, y]);

  if (count <= 0) return null;
  return (
    <Animated.View pointerEvents="none" style={[styles.wrap, { transform: [{ translateY: y }] }]}>
      <View style={[styles.card, shadow]}>
        <View style={styles.icon}>
          <Icon name="flash" size={20} color={C.onAccent} />
        </View>
        <View style={{ flex: 1 }}>
          <Text style={styles.title}>{count === 1 ? "New delivery" : `${count} new deliveries`}</Text>
          <Text style={styles.sub}>Dispatch just sent you {count === 1 ? "a stop" : "stops"}</Text>
        </View>
      </View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  wrap: { position: "absolute", top: 8, left: 12, right: 12, zIndex: 50 },
  card: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    padding: 14,
    borderRadius: R.lg,
    backgroundColor: C.surface,
    borderWidth: 1,
    borderColor: C.go,
  },
  icon: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: C.go,
    alignItems: "center",
    justifyContent: "center",
  },
  title: { color: C.text, fontWeight: "900", fontSize: 16 },
  sub: { color: C.textDim, fontSize: 13, marginTop: 1 },
});
