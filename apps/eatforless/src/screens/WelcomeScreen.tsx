// Onboarding / sign-in: Apple, Google or email — or browse first. Ordering
// asks again if they skipped.

import * as AppleAuthentication from "expo-apple-authentication";
import { StatusBar } from "expo-status-bar";
import { useEffect, useState } from "react";
import { ActivityIndicator, Alert, StyleSheet, View } from "react-native";
import Animated, { Easing, useAnimatedStyle, useSharedValue, withDelay, withRepeat, withSequence, withTiming } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import Svg, { Path } from "react-native-svg";
import { signInNative } from "@/api/efl";
import { appleIdToken, googleConfigured, googleIdToken, isAppleSignInAvailable } from "@/auth/native";
import { useSession } from "@/auth/session";
import { TagMark } from "@/components/Bits";
import { FoodArt } from "@/components/FoodArt";
import { Icon } from "@/components/Icon";
import { PressScale } from "@/components/PressScale";
import { T } from "@/components/T";
import { MOCK } from "@/config";
import type { FoodKind } from "@/lib/menu";
import { fadeUp } from "@/lib/motion";
import type { RootScreen } from "@/navigation/types";
import { C, F } from "@/theme";

function Floating({ kind, x, y, size, delay, rotate }: { kind: FoodKind; x: number; y: number; size: number; delay: number; rotate: number }) {
  const t = useSharedValue(0);
  useEffect(() => {
    t.value = withDelay(delay, withRepeat(withSequence(withTiming(1, { duration: 2600, easing: Easing.inOut(Easing.sin) }), withTiming(0, { duration: 2600, easing: Easing.inOut(Easing.sin) })), -1));
  }, [t, delay]);
  const style = useAnimatedStyle(() => ({ transform: [{ translateY: -8 * t.value }, { rotate: `${rotate + t.value * 4}deg` }] }));
  return (
    <Animated.View entering={fadeUp(200 + delay / 3, 30, 900)} style={[{ position: "absolute", left: x, top: y }, style]}>
      <FoodArt kind={kind} style={{ width: size, height: size * 0.75, borderRadius: 22 }} />
    </Animated.View>
  );
}

function GoogleG() {
  return (
    <Svg width={18} height={18} viewBox="0 0 48 48">
      <Path fill="#EA4335" d="M24 9.5c3.5 0 6.6 1.2 9.1 3.6l6.8-6.8C35.8 2.4 30.3 0 24 0 14.6 0 6.6 5.4 2.7 13.2l7.9 6.1C12.5 13.6 17.8 9.5 24 9.5z" />
      <Path fill="#4285F4" d="M46.1 24.5c0-1.6-.1-3.1-.4-4.5H24v9h12.4c-.5 2.9-2.2 5.3-4.6 6.9l7.4 5.7c4.3-4 6.9-9.9 6.9-17.1z" />
      <Path fill="#FBBC05" d="M10.6 28.7c-.5-1.4-.8-3-.8-4.7s.3-3.3.8-4.7l-7.9-6.1C1 16.6 0 20.2 0 24s1 7.4 2.7 10.8l7.9-6.1z" />
      <Path fill="#34A853" d="M24 48c6.5 0 11.9-2.1 15.9-5.8l-7.4-5.7c-2.1 1.4-4.8 2.3-8.5 2.3-6.2 0-11.5-4.1-13.4-9.8l-7.9 6.1C6.6 42.6 14.6 48 24 48z" />
    </Svg>
  );
}

export function WelcomeScreen({ navigation }: RootScreen<"Welcome">) {
  const insets = useSafeAreaInsets();
  const signIn = useSession((s) => s.signIn);
  const finishOnboarding = useSession((s) => s.finishOnboarding);
  const [apple, setApple] = useState(false);
  const [busy, setBusy] = useState<null | "apple" | "google">(null);

  useEffect(() => {
    void isAppleSignInAvailable().then(setApple);
  }, []);

  const done = () => {
    if (navigation.canGoBack()) navigation.goBack();
    else navigation.reset({ index: 0, routes: [{ name: "Tabs" }] });
  };

  const run = async (provider: "apple" | "google") => {
    setBusy(provider);
    try {
      const token = MOCK ? { idToken: "mock-id-token-for-sample-mode" } : provider === "apple" ? await appleIdToken() : await googleIdToken();
      if (!token) return;
      await signIn(await signInNative({ provider, ...token }));
      done();
    } catch (err) {
      Alert.alert("Couldn't sign you in", (err as Error).message);
    } finally {
      setBusy(null);
    }
  };

  return (
    <View style={styles.root}>
      <StatusBar style="light" />
      <View style={[styles.top, { paddingTop: insets.top + 24 }]}>
        <Floating kind="pizza" x={-30} y={insets.top + 150} size={150} delay={0} rotate={-8} />
        <Floating kind="burger" x={230} y={insets.top + 110} size={140} delay={400} rotate={6} />
        <Floating kind="dessert" x={150} y={insets.top + 260} size={120} delay={800} rotate={-4} />
        <Animated.View entering={fadeUp(0, 30, 800)} style={styles.brandRow}>
          <T style={styles.word}>eat for </T>
          <View style={styles.lessWrap}>
            <T style={[styles.word, { color: C.ink }]}>less</T>
          </View>
          <TagMark size={34} style={{ marginLeft: 8, transform: [{ rotate: "-12deg" }] }} />
        </Animated.View>
      </View>

      <Animated.View entering={fadeUp(250, 60, 800)} style={[styles.card, { paddingBottom: insets.bottom + 18 }]}>
        <T v="hero" style={{ fontSize: 30, lineHeight: 34 }}>Your local favourites.{"\n"}Fairer prices.</T>
        <T v="sub" style={{ fontSize: 15, lineHeight: 21 }}>Order from shops in Newcastle and Tyne and Wear for less than on the big apps.</T>

        <View style={{ gap: 10, marginTop: 6 }}>
          {apple && !MOCK ? (
            <AppleAuthentication.AppleAuthenticationButton
              buttonType={AppleAuthentication.AppleAuthenticationButtonType.CONTINUE}
              buttonStyle={AppleAuthentication.AppleAuthenticationButtonStyle.BLACK}
              cornerRadius={27}
              style={{ height: 54 }}
              onPress={() => run("apple")}
            />
          ) : (
            <PressScale onPress={() => run("apple")} style={[styles.btn, { backgroundColor: C.ink }]} haptic>
              {busy === "apple" ? <ActivityIndicator color={C.white} /> : <T style={[styles.btnText, { color: C.white }]}>Continue with Apple</T>}
            </PressScale>
          )}
          <PressScale onPress={() => run("google")} style={[styles.btn, styles.btnOutline, !googleConfigured && !MOCK && { opacity: 0.55 }]} haptic>
            {busy === "google" ? <ActivityIndicator color={C.ink} /> : (
              <>
                <GoogleG />
                <T style={styles.btnText}>Continue with Google</T>
              </>
            )}
          </PressScale>
          <PressScale onPress={() => navigation.navigate("EmailAuth", { mode: "signin" })} style={[styles.btn, styles.btnOutline]} haptic>
            <Icon name="mail" size={18} />
            <T style={styles.btnText}>Continue with email</T>
          </PressScale>
        </View>

        <PressScale
          onPress={async () => {
            await finishOnboarding();
            done();
          }}
          style={{ alignSelf: "center", paddingVertical: 10 }}
        >
          <T style={{ fontFamily: F.bold, fontSize: 15, textDecorationLine: "underline" }}>Browse first</T>
        </PressScale>
        <T v="small" style={{ textAlign: "center", fontFamily: F.regular, lineHeight: 17 }}>
          By continuing you agree to Eat For Less's Terms and Privacy Policy.
        </T>
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: C.ink },
  top: { flex: 1, paddingHorizontal: 24, overflow: "hidden" },
  brandRow: { flexDirection: "row", alignItems: "center" },
  word: { fontFamily: F.display, fontSize: 34, letterSpacing: -1.4, color: C.white },
  lessWrap: { backgroundColor: C.lime, borderRadius: 7, paddingHorizontal: 4 },
  card: { backgroundColor: C.white, borderTopLeftRadius: 28, borderTopRightRadius: 28, paddingHorizontal: 20, paddingTop: 26, gap: 12 },
  btn: { height: 54, borderRadius: 27, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 10 },
  btnOutline: { borderWidth: 1.5, borderColor: C.grey300, backgroundColor: C.white },
  btnText: { fontFamily: F.bold, fontSize: 16, color: C.ink },
});
