// Email sign-in and sign-up. Sign-up needs the email confirmed before the
// first sign-in (the API sends the link), so it ends on a "check your inbox".

import { useState } from "react";
import { ActivityIndicator, KeyboardAvoidingView, Platform, ScrollView, StyleSheet, Switch, TextInput, View } from "react-native";
import Animated from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { loginEmail, signupEmail } from "@/api/efl";
import { useSession } from "@/auth/session";
import { RoundButton, TagMark } from "@/components/Bits";
import { PressScale } from "@/components/PressScale";
import { T } from "@/components/T";
import { fadeUp } from "@/lib/motion";
import type { RootScreen } from "@/navigation/types";
import { C, F } from "@/theme";

export function EmailAuthScreen({ navigation, route }: RootScreen<"EmailAuth">) {
  const insets = useSafeAreaInsets();
  const signIn = useSession((s) => s.signIn);
  const [mode, setMode] = useState(route.params.mode);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [firstName, setFirst] = useState("");
  const [lastName, setLast] = useState("");
  const [offers, setOffers] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sentTo, setSentTo] = useState<string | null>(null);

  const signup = mode === "signup";
  const valid = /\S+@\S+\.\S+/.test(email) && password.length >= (signup ? 8 : 1) && (!signup || (firstName.trim() && lastName.trim()));

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      if (signup) {
        const res = await signupEmail({ email: email.trim(), password, firstName: firstName.trim(), lastName: lastName.trim(), marketingOptIn: offers });
        setSentTo(res.email);
      } else {
        await signIn(await loginEmail(email.trim(), password));
        // Back past the Welcome screen to wherever sign-in was asked for.
        const state = navigation.getState();
        const welcomeIdx = state.routes.findIndex((r) => r.name === "Welcome");
        if (welcomeIdx > 0) navigation.pop(state.routes.length - welcomeIdx);
        else navigation.reset({ index: 0, routes: [{ name: "Tabs" }] });
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (sentTo) {
    return (
      <View style={[styles.root, { paddingTop: insets.top + 8, paddingHorizontal: 20 }]}>
        <RoundButton icon="back" label="Back" light onPress={() => setSentTo(null)} />
        <Animated.View entering={fadeUp(60)} style={{ gap: 12, marginTop: 40, alignItems: "flex-start" }}>
          <TagMark size={52} />
          <T v="hero">Check your inbox</T>
          <T v="sub" style={{ fontSize: 15, lineHeight: 21 }}>
            We sent a link to <T style={{ fontFamily: F.bold, color: C.ink, fontSize: 15 }}>{sentTo}</T>. Tap it to confirm your email, then sign in here.
          </T>
          <PressScale onPress={() => { setSentTo(null); setMode("signin"); }} style={styles.primary}>
            <T style={styles.primaryText}>Go to sign in</T>
          </PressScale>
        </Animated.View>
      </View>
    );
  }

  return (
    <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined} style={styles.root}>
      <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ paddingTop: insets.top + 8, paddingHorizontal: 20, paddingBottom: 40, gap: 14 }}>
        <RoundButton icon="back" label="Back" light onPress={() => navigation.goBack()} />
        <Animated.View entering={fadeUp(40)} style={{ gap: 6, marginTop: 8 }}>
          <T v="hero">{signup ? "Create your account" : "Sign in with email"}</T>
          <T v="sub" style={{ fontSize: 15 }}>{signup ? "Takes a minute. We'll confirm your email." : "Welcome back."}</T>
        </Animated.View>

        <Animated.View entering={fadeUp(100)} style={{ gap: 10 }}>
          {signup ? (
            <View style={{ flexDirection: "row", gap: 10 }}>
              <Field style={{ flex: 1 }} label="First name" value={firstName} onChangeText={setFirst} autoComplete="given-name" textContentType="givenName" />
              <Field style={{ flex: 1 }} label="Last name" value={lastName} onChangeText={setLast} autoComplete="family-name" textContentType="familyName" />
            </View>
          ) : null}
          <Field label="Email" value={email} onChangeText={setEmail} keyboardType="email-address" autoCapitalize="none" autoComplete="email" textContentType="emailAddress" />
          <Field
            label={signup ? "Password (8+ characters)" : "Password"}
            value={password}
            onChangeText={setPassword}
            secureTextEntry
            autoComplete={signup ? "new-password" : "current-password"}
            textContentType={signup ? "newPassword" : "password"}
          />
          {signup ? (
            <View style={styles.switchRow}>
              <T v="body" style={{ flex: 1, fontSize: 14 }}>Send me Eat For Less offers by email</T>
              <Switch value={offers} onValueChange={setOffers} trackColor={{ true: C.ink }} />
            </View>
          ) : null}
          {error ? <T style={styles.error}>{error}</T> : null}
          <PressScale onPress={submit} disabled={!valid || busy} style={[styles.primary, (!valid || busy) && { opacity: 0.4 }]} haptic>
            {busy ? <ActivityIndicator color={C.white} /> : <T style={styles.primaryText}>{signup ? "Create account" : "Sign in"}</T>}
          </PressScale>
          <PressScale onPress={() => { setMode(signup ? "signin" : "signup"); setError(null); }} style={{ alignSelf: "center", paddingVertical: 8 }}>
            <T style={{ fontFamily: F.semibold, fontSize: 14 }}>
              {signup ? "Already have an account? " : "New to Eat For Less? "}
              <T style={{ fontFamily: F.bold, fontSize: 14, textDecorationLine: "underline" }}>{signup ? "Sign in" : "Create one"}</T>
            </T>
          </PressScale>
        </Animated.View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

function Field({ label, style, ...rest }: React.ComponentProps<typeof TextInput> & { label: string }) {
  return (
    <View style={[{ gap: 6 }, style]}>
      <T v="small" style={{ color: C.ink }}>{label}</T>
      <TextInput placeholderTextColor={C.grey500} style={styles.input} {...rest} />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: C.white },
  input: { height: 52, borderRadius: 14, backgroundColor: C.grey100, paddingHorizontal: 14, fontFamily: F.regular, fontSize: 16, color: C.ink },
  switchRow: { flexDirection: "row", alignItems: "center", gap: 12, paddingVertical: 4 },
  error: { fontFamily: F.semibold, fontSize: 14, color: C.red },
  primary: { height: 54, borderRadius: 27, backgroundColor: C.ink, alignItems: "center", justifyContent: "center", alignSelf: "stretch", marginTop: 6 },
  primaryText: { fontFamily: F.bold, fontSize: 16, color: C.white },
});
