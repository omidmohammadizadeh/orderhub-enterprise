// S2 · Private call — STUB until Phase 4 (masked numbers). The screen, its
// promises and controls are the approved design; no call is placed. When the
// masking service exists, "start" will ask the API for a proxy number and
// dial it (README → next steps).

import { StatusBar } from "expo-status-bar";
import { useEffect, useState } from "react";
import { StyleSheet, View } from "react-native";
import Animated, { Easing, useAnimatedStyle, useSharedValue, withDelay, withRepeat, withSequence, withTiming } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
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

function Bar({ h, delay }: { h: number; delay: number }) {
  const t = useSharedValue(0.3);
  useEffect(() => {
    t.value = withDelay(delay, withRepeat(withSequence(withTiming(1, { duration: 500 }), withTiming(0.3, { duration: 500 })), -1));
  }, [t, delay]);
  const style = useAnimatedStyle(() => ({ transform: [{ scaleY: t.value }] }));
  return <Animated.View style={[styles.bar, { height: h }, style]} />;
}

function Control({ icon, label, on, onPress, danger }: { icon: "mic" | "speaker" | "phone"; label: string; on?: boolean; onPress: () => void; danger?: boolean }) {
  return (
    <View style={{ alignItems: "center", gap: 8 }}>
      <PressScale onPress={onPress} scaleTo={0.92} accessibilityLabel={label} style={[styles.ctrl, { backgroundColor: danger ? C.red : on ? C.white : C.ink2 }]} haptic>
        <View style={danger ? { transform: [{ rotate: "135deg" }] } : undefined}>
          <Icon name={icon} size={26} color={danger ? C.white : on ? C.ink : C.white} fill={danger ? C.white : "none"} />
        </View>
      </PressScale>
      <T style={{ fontFamily: F.regular, fontSize: 12, color: "#BDBDBD" }}>{label}</T>
    </View>
  );
}

export function CallScreen({ navigation, route }: RootScreen<"Call">) {
  const insets = useSafeAreaInsets();
  const { name } = route.params;
  const [muted, setMuted] = useState(false);
  const [speaker, setSpeaker] = useState(false);

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
      <Animated.Text entering={fadeUp(120)} style={styles.sub}>Private calls are coming soon</Animated.Text>
      <View style={styles.wave}>
        {[14, 26, 34, 22, 30, 16, 28, 12].map((h, i) => <Bar key={i} h={h} delay={i * 100} />)}
      </View>
      <Animated.View entering={fadeUp(200)} style={styles.promises}>
        {[
          `${name} will see “Eat For Less customer”, never your number.`,
          "You won't see their number either.",
          "The line closes 2 hours after delivery.",
        ].map((line) => (
          <View key={line} style={{ flexDirection: "row", gap: 10 }}>
            <Icon name="check" size={16} color={C.lime} />
            <T style={{ flex: 1, fontFamily: F.regular, fontSize: 14, lineHeight: 20, color: C.white }}>{line}</T>
          </View>
        ))}
      </Animated.View>
      <View style={{ flex: 1 }} />
      <View style={styles.controls}>
        <Control icon="mic" label="Mute" on={muted} onPress={() => setMuted((m) => !m)} />
        <Control icon="phone" label="End" danger onPress={() => navigation.goBack()} />
        <Control icon="speaker" label="Speaker" on={speaker} onPress={() => setSpeaker((s) => !s)} />
      </View>
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
  wave: { flexDirection: "row", alignItems: "center", gap: 4, height: 36, marginTop: 22 },
  bar: { width: 4, borderRadius: 2, backgroundColor: C.lime },
  promises: { marginTop: 30, alignSelf: "stretch", backgroundColor: "#161616", borderWidth: 1, borderColor: C.ink2, borderRadius: 18, padding: 16, gap: 10 },
  controls: { flexDirection: "row", gap: 28, alignItems: "flex-start" },
  ctrl: { width: 68, height: 68, borderRadius: 34, alignItems: "center", justifyContent: "center" },
});
