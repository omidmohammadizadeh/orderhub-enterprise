// S2 · Private call. "Call" hands the phone our private-line number with this
// customer's code keyed after a pause; the line asks for the code and puts
// them through to their driver (or the shop, before a driver has the food).
// Neither side ever sees the other's number.

import { StatusBar } from "expo-status-bar";
import { useEffect } from "react";
import { Linking, StyleSheet, View } from "react-native";
import Animated, { Easing, useAnimatedStyle, useSharedValue, withDelay, withRepeat, withTiming } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useMyOrder } from "@/api/hooks";
import { Icon } from "@/components/Icon";
import { PressScale } from "@/components/PressScale";
import { T } from "@/components/T";
import { fadeUp } from "@/lib/motion";
import type { RootScreen } from "@/navigation/types";
import { C, F } from "@/theme";

function Ring({ delay }: { delay: number }) {
  const t = useSharedValue(0);
  useEffect(() => {
    t.value = withDelay(delay, withRepeat(withTiming(1, { duration: 2400, easing: Easing.out(Easing.quad) }), -1));
  }, [t, delay]);
  const style = useAnimatedStyle(() => ({ opacity: 0.7 * (1 - t.value), transform: [{ scale: 1 + 0.9 * t.value }] }));
  return <Animated.View style={[styles.ring, style]} />;
}

/**
 * The number, three pauses, then the code. %2C is a comma that survives both
 * diallers (some Android ones drop a raw comma); three pauses give the line
 * time to answer before the digits are sent. Same form the driver app uses.
 */
function telUrl(number: string, code: string) {
  const dial = number.replace(/[^\d+]/g, "").replace(/(?!^)\+/g, "");
  return `tel:${dial}%2C%2C%2C${code.replace(/\D/g, "")}`;
}

export function CallScreen({ navigation, route }: RootScreen<"Call">) {
  const insets = useSafeAreaInsets();
  const { orderId, name } = route.params;
  const { data: order, isLoading } = useMyOrder(orderId);
  const line = order?.privateLine ?? null;

  const status = isLoading
    ? "Opening your private line…"
    : line
      ? "Your number stays private"
      : "Private calls aren't open for this order";

  return (
    <View style={[styles.root, { paddingTop: insets.top + 40, paddingBottom: insets.bottom + 32 }]}>
      <StatusBar style="light" />
      <Animated.View entering={fadeUp(0)} style={styles.chip}>
        <Icon name="lock" size={14} color={C.lime} strokeWidth={2.4} />
        <T style={{ fontFamily: F.bold, fontSize: 13, color: C.white }}>Private line</T>
      </Animated.View>
      <View style={styles.avatarWrap}>
        <Ring delay={0} />
        <Ring delay={800} />
        <Ring delay={1600} />
        <View style={styles.avatar}>
          <T style={{ fontFamily: F.display, fontSize: 48, color: C.white }}>{name[0]?.toUpperCase()}</T>
        </View>
      </View>
      <Animated.Text entering={fadeUp(80)} style={styles.name}>{name}</Animated.Text>
      <Animated.Text entering={fadeUp(120)} style={styles.sub}>{status}</Animated.Text>
      <Animated.View entering={fadeUp(200)} style={styles.promises}>
        {[
          `${name} sees the Eat For Less number, never yours.`,
          "You won't see their number either.",
          "The line closes 2 hours after delivery.",
        ].map((text) => (
          <View key={text} style={{ flexDirection: "row", gap: 10 }}>
            <Icon name="check" size={16} color={C.lime} />
            <T style={{ flex: 1, fontFamily: F.regular, fontSize: 14, lineHeight: 20, color: C.white }}>{text}</T>
          </View>
        ))}
      </Animated.View>
      {line ? (
        <T style={styles.code} accessibilityLabel={`Your call code is ${line.code.split("").join(" ")}`}>
          Your code {line.code.slice(0, 3)} {line.code.slice(3)} is keyed for you
        </T>
      ) : null}
      <View style={{ flex: 1 }} />
      <PressScale
        onPress={() => line && Linking.openURL(telUrl(line.number, line.code))}
        disabled={!line}
        style={[styles.call, !line && { opacity: 0.35 }]}
        accessibilityRole="button"
        accessibilityLabel={`Call ${name}`}
        haptic
      >
        <Icon name="phone" size={22} color={C.ink} />
        <T style={{ fontFamily: F.heavy, fontSize: 17, color: C.ink }}>Call {name}</T>
      </PressScale>
      <PressScale onPress={() => navigation.goBack()} style={styles.close} accessibilityRole="button" accessibilityLabel="Close">
        <T style={{ fontFamily: F.bold, fontSize: 15, color: C.white }}>Close</T>
      </PressScale>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: C.ink, alignItems: "center", paddingHorizontal: 24 },
  chip: { flexDirection: "row", alignItems: "center", gap: 8, backgroundColor: C.ink3, borderRadius: 16, paddingHorizontal: 12, paddingVertical: 8 },
  avatarWrap: { width: 128, height: 128, marginTop: 44 },
  ring: { position: "absolute", width: 128, height: 128, borderRadius: 64, borderWidth: 2, borderColor: C.lime },
  avatar: { width: 128, height: 128, borderRadius: 64, backgroundColor: "#2A2A2A", alignItems: "center", justifyContent: "center" },
  name: { marginTop: 32, fontFamily: F.display, fontSize: 30, letterSpacing: -0.6, color: C.white },
  sub: { marginTop: 6, fontFamily: F.regular, fontSize: 15, color: "#BDBDBD" },
  promises: { marginTop: 30, alignSelf: "stretch", backgroundColor: "#161616", borderWidth: 1, borderColor: C.ink2, borderRadius: 18, padding: 16, gap: 10 },
  code: { marginTop: 14, fontFamily: F.medium, fontSize: 13, color: "#8C8C8C", fontVariant: ["tabular-nums"] },
  call: {
    alignSelf: "stretch",
    height: 58,
    borderRadius: 29,
    backgroundColor: C.lime,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 10,
  },
  close: { marginTop: 12, height: 48, alignSelf: "stretch", alignItems: "center", justifyContent: "center" },
});
