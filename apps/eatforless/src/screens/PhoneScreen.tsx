// S1 · Customer phone check — mobile number, then the 6-digit code on our own
// keypad. The API refuses orders until this is done.

import * as Haptics from "expo-haptics";
import { useEffect, useState } from "react";
import { ActivityIndicator, StyleSheet, View } from "react-native";
import Animated, {
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withDelay,
  withRepeat,
  withSequence,
  withSpring,
  withTiming,
} from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { startPhone, verifyPhone } from "@/api/efl";
import { useSession } from "@/auth/session";
import { RoundButton } from "@/components/Bits";
import { Icon } from "@/components/Icon";
import { PressScale } from "@/components/PressScale";
import { T } from "@/components/T";
import { fadeUp } from "@/lib/motion";
import type { RootScreen } from "@/navigation/types";
import { C, F, MOTION } from "@/theme";

const KEYS = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "C", "0", "⌫"];

function Keypad({ onKey }: { onKey: (k: string) => void }) {
  const insets = useSafeAreaInsets();
  return (
    <View style={[styles.pad, { paddingBottom: Math.max(insets.bottom, 16) + 10 }]}>
      {KEYS.map((k) => {
        const fn = k === "C" || k === "⌫";
        return (
          <PressScale
            key={k}
            onPress={() => {
              void Haptics.selectionAsync();
              onKey(k);
            }}
            scaleTo={0.94}
            accessibilityLabel={k === "⌫" ? "Delete" : k === "C" ? "Clear" : k}
            style={[styles.key, fn && { backgroundColor: "transparent" }]}
          >
            {k === "⌫" ? <Icon name="back" size={24} /> : <T style={styles.keyText}>{k}</T>}
          </PressScale>
        );
      })}
    </View>
  );
}

function Box({ value, active, done, pop }: { value: string; active: boolean; done: boolean; pop: boolean }) {
  const s = useSharedValue(1);
  const caret = useSharedValue(1);
  useEffect(() => {
    if (pop) s.value = withSequence(withTiming(1.08, { duration: 80 }), withSpring(1, MOTION.bouncy));
  }, [pop, s]);
  useEffect(() => {
    caret.value = active ? withRepeat(withSequence(withTiming(1, { duration: 0 }), withDelay(500, withTiming(0, { duration: 0 })), withDelay(500, withTiming(1, { duration: 0 }))), -1) : 0;
  }, [active, caret]);
  const boxStyle = useAnimatedStyle(() => ({ transform: [{ scale: s.value }] }));
  const caretStyle = useAnimatedStyle(() => ({ opacity: caret.value }));
  return (
    <Animated.View style={[styles.box, { borderColor: done || active ? C.ink : C.grey100 }, boxStyle]}>
      {value ? <T style={styles.boxText}>{value}</T> : active ? <Animated.View style={[styles.caret, caretStyle]} /> : null}
    </Animated.View>
  );
}

function Tick() {
  const p = useSharedValue(0);
  useEffect(() => {
    p.value = withSpring(1, { damping: 9, stiffness: 180 });
  }, [p]);
  const style = useAnimatedStyle(() => ({ opacity: p.value, transform: [{ scale: 0.3 + 0.7 * p.value }] }));
  return (
    <Animated.View style={[styles.ok, style]}>
      <Icon name="check" size={22} />
      <T style={{ fontFamily: F.bold, fontSize: 14 }}>Phone verified. Welcome to Eat For Less.</T>
    </Animated.View>
  );
}

function Shield() {
  const t = useSharedValue(0);
  useEffect(() => {
    t.value = withRepeat(withSequence(withTiming(1, { duration: 1500, easing: Easing.inOut(Easing.sin) }), withTiming(0, { duration: 1500, easing: Easing.inOut(Easing.sin) })), -1);
  }, [t]);
  const style = useAnimatedStyle(() => ({ transform: [{ translateY: -5 * t.value }] }));
  return (
    <Animated.View style={style}>
      <Icon name="shield" size={44} fill={C.lime} strokeWidth={1.8} />
    </Animated.View>
  );
}

/** "07700 900123" style grouping while typing. */
const groupUk = (d: string) => (d.length > 5 ? `${d.slice(0, 5)} ${d.slice(5, 11)}` : d);

export function PhoneScreen({ navigation, route }: RootScreen<"Phone">) {
  const insets = useSafeAreaInsets();
  const refreshFlags = useSession((s) => s.refreshFlags);
  const [step, setStep] = useState<"number" | "code">("number");
  const [digits, setDigits] = useState("07");
  const [masked, setMasked] = useState("");
  const [code, setCode] = useState("");
  const [pop, setPop] = useState(-1);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [verified, setVerified] = useState(false);
  const [resendIn, setResendIn] = useState(0);

  useEffect(() => {
    if (resendIn <= 0) return;
    const t = setTimeout(() => setResendIn((s) => s - 1), 1000);
    return () => clearTimeout(t);
  }, [resendIn]);

  const send = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await startPhone(digits);
      setMasked(res.phone);
      setStep("code");
      setCode("");
      setResendIn(45);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const check = async (full: string) => {
    setBusy(true);
    setError(null);
    try {
      await verifyPhone(full);
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      setVerified(true);
      // The API has just confirmed it; GET efl/me then brings the stored number.
      useSession.setState({ phoneVerified: true });
      void refreshFlags();
      setTimeout(() => navigation.goBack(), 1100);
    } catch (err) {
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      setError((err as Error).message);
      setCode("");
    } finally {
      setBusy(false);
    }
  };

  const onKey = (k: string) => {
    if (verified || busy) return;
    if (step === "number") {
      if (k === "C") setDigits("");
      else if (k === "⌫") setDigits((d) => d.slice(0, -1));
      else if (digits.length < 11) setDigits((d) => d + k);
      return;
    }
    if (k === "C") return setCode("");
    if (k === "⌫") return setCode((c) => c.slice(0, -1));
    if (code.length >= 6) return;
    const next = code + k;
    setCode(next);
    setPop(next.length - 1);
    setTimeout(() => setPop(-1), 160);
    if (next.length === 6) void check(next);
  };

  const numberOk = /^07\d{9}$/.test(digits);

  return (
    <View style={styles.root}>
      <View style={[styles.body, { paddingTop: insets.top + 12 }]}>
        <RoundButton icon={step === "code" ? "back" : "close"} label={step === "code" ? "Change number" : "Close"} light onPress={() => (step === "code" ? setStep("number") : navigation.goBack())} />

        {step === "number" ? (
          <Animated.View key="number" entering={fadeUp(40)} style={{ gap: 18 }}>
            <View style={{ gap: 8 }}>
              <Shield />
              <T v="hero" style={{ lineHeight: 31 }}>What's your mobile number?</T>
              <T v="sub" style={{ fontSize: 15, lineHeight: 21 }}>
                We'll text you a code. It keeps your account safe, and lets your driver reach you{route.params?.then ? " — you need it to order" : ""}.
              </T>
            </View>
            <View style={styles.numberField}>
              <T style={styles.flag}>UK</T>
              <T style={styles.number}>{groupUk(digits) || " "}</T>
            </View>
            {error ? <T style={styles.error}>{error}</T> : null}
            <PressScale onPress={send} disabled={!numberOk || busy} style={[styles.primary, (!numberOk || busy) && { opacity: 0.35 }]} haptic>
              {busy ? <ActivityIndicator color={C.white} /> : <T style={styles.primaryText}>Text me a code</T>}
            </PressScale>
          </Animated.View>
        ) : (
          <Animated.View key="code" entering={fadeUp(40)} style={{ gap: 18 }}>
            <View style={{ gap: 8 }}>
              <Shield />
              <T v="hero" style={{ lineHeight: 31 }}>Enter the 6-digit code</T>
              <T v="sub" style={{ fontSize: 15, lineHeight: 21 }}>
                We sent it by text to <T style={{ fontFamily: F.bold, color: C.ink, fontSize: 15 }}>{masked}</T>. This keeps your account safe.
              </T>
            </View>
            <View style={styles.boxes}>
              {[0, 1, 2, 3, 4, 5].map((i) => (
                <Box key={i} value={code[i] ?? ""} active={!verified && i === code.length} done={verified} pop={pop === i} />
              ))}
            </View>
            {verified ? (
              <Tick />
            ) : busy ? (
              <ActivityIndicator color={C.ink} />
            ) : (
              <View style={{ gap: 8 }}>
                {error ? <T style={styles.error}>{error}</T> : null}
                <View style={styles.rowBetween}>
                  <T v="sub" style={{ fontSize: 14 }}>{resendIn > 0 ? `Resend code in 0:${String(resendIn).padStart(2, "0")}` : "Didn't get it?"}</T>
                  <PressScale disabled={resendIn > 0} onPress={send}>
                    <T style={{ fontFamily: F.bold, fontSize: 14, textDecorationLine: "underline", opacity: resendIn > 0 ? 0.35 : 1 }}>Send again</T>
                  </PressScale>
                </View>
              </View>
            )}
          </Animated.View>
        )}
      </View>
      <Keypad onKey={onKey} />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: C.white },
  body: { flex: 1, paddingHorizontal: 20, gap: 18 },
  numberField: { flexDirection: "row", alignItems: "center", gap: 12, height: 60, borderRadius: 14, backgroundColor: C.grey100, paddingHorizontal: 16, borderWidth: 2, borderColor: C.ink },
  flag: { fontFamily: F.bold, fontSize: 15, color: C.grey600 },
  number: { fontFamily: F.display, fontSize: 24, letterSpacing: 0.5, color: C.ink },
  boxes: { flexDirection: "row", gap: 8 },
  box: { flex: 1, height: 60, borderRadius: 14, backgroundColor: C.grey100, borderWidth: 2, alignItems: "center", justifyContent: "center" },
  boxText: { fontFamily: F.display, fontSize: 26, color: C.ink },
  caret: { width: 2, height: 26, backgroundColor: C.ink },
  ok: { flexDirection: "row", alignItems: "center", gap: 10, backgroundColor: C.lime, borderRadius: 14, paddingHorizontal: 14, paddingVertical: 12 },
  rowBetween: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  error: { fontFamily: F.semibold, fontSize: 14, color: C.red },
  primary: { height: 54, borderRadius: 27, backgroundColor: C.ink, alignItems: "center", justifyContent: "center" },
  primaryText: { fontFamily: F.bold, fontSize: 16, color: C.white },
  pad: { backgroundColor: C.grey50, paddingTop: 10, paddingHorizontal: 10, flexDirection: "row", flexWrap: "wrap", gap: 8 },
  key: { width: "31.8%", height: 54, borderRadius: 12, backgroundColor: C.white, alignItems: "center", justifyContent: "center" },
  keyText: { fontFamily: F.displayBold, fontSize: 24, color: C.ink },
});
