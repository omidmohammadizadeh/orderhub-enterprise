import { useEffect, useState } from "react";
import {
  Alert,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import * as AppleAuthentication from "expo-apple-authentication";
import { AuthTokens, exchangeAppleIdToken, exchangeGoogleIdToken, loginWithEmailPassword } from "@/services/auth";
import { signInWithGoogle } from "@/services/google";
import { isAppleSignInAvailable, signInWithApple } from "@/services/apple";
import { Button, Icon } from "@/components/ui";
import { C, R } from "@/theme";

// The API's own message ("Invalid credentials") beats axios's status-code text.
function apiMessage(err: unknown): string {
  const detail = (err as { response?: { data?: { message?: string | string[] } } })?.response?.data?.message;
  if (Array.isArray(detail)) return detail.join("\n");
  return detail || (err as Error)?.message || "Please try again.";
}

export function LoginScreen({ onSignedIn }: { onSignedIn: (t: AuthTokens) => void }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [busy, setBusy] = useState(false);
  const [appleAvailable, setAppleAvailable] = useState(false);

  useEffect(() => {
    isAppleSignInAvailable().then(setAppleAvailable);
  }, []);

  async function run(fn: () => Promise<AuthTokens | null>) {
    setBusy(true);
    try {
      const t = await fn();
      if (t) onSignedIn(t);
    } catch (err: unknown) {
      Alert.alert("Sign-in failed", apiMessage(err));
    } finally {
      setBusy(false);
    }
  }

  const canSubmit = !!email.trim() && !!password;

  return (
    <KeyboardAvoidingView style={styles.container} behavior={Platform.OS === "ios" ? "padding" : "height"}>
      <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
        <View style={styles.logoWrap}>
          <View style={styles.logo}>
            <Icon name="navigate" size={30} color={C.onAccent} />
          </View>
        </View>
        <Text style={styles.brand}>Order Hub</Text>
        <Text style={styles.subtitle}>DRIVER</Text>
        <Text style={styles.tagline}>Sign in to start your shift</Text>

        <View style={styles.field}>
          <Icon name="mail-outline" size={18} color={C.textMute} />
          <TextInput
            style={styles.input}
            placeholder="Email"
            placeholderTextColor={C.textMute}
            autoCapitalize="none"
            autoComplete="email"
            keyboardType="email-address"
            textContentType="username"
            value={email}
            onChangeText={setEmail}
          />
        </View>
        <View style={styles.field}>
          <Icon name="lock-closed-outline" size={18} color={C.textMute} />
          <TextInput
            style={styles.input}
            placeholder="Password"
            placeholderTextColor={C.textMute}
            secureTextEntry={!showPassword}
            textContentType="password"
            autoComplete="password"
            value={password}
            onChangeText={setPassword}
            onSubmitEditing={() => canSubmit && run(() => loginWithEmailPassword(email.trim(), password))}
          />
          <Pressable onPress={() => setShowPassword((v) => !v)} hitSlop={10} accessibilityLabel="Show password">
            <Icon name={showPassword ? "eye-off-outline" : "eye-outline"} size={18} color={C.textMute} />
          </Pressable>
        </View>

        <Button
          label="Sign in"
          tone="go"
          busy={busy}
          disabled={!canSubmit}
          style={{ marginTop: 6 }}
          onPress={() => run(() => loginWithEmailPassword(email.trim(), password))}
        />

        <View style={styles.orRow}>
          <View style={styles.orLine} />
          <Text style={styles.orText}>or</Text>
          <View style={styles.orLine} />
        </View>

        <Pressable
          style={(s) => [styles.oauth, s.pressed && { opacity: 0.85 }]}
          disabled={busy}
          onPress={() =>
            run(async () => {
              const idToken = await signInWithGoogle();
              return idToken ? exchangeGoogleIdToken(idToken) : null;
            })
          }
        >
          <Icon name="logo-google" size={18} color={C.bg} />
          <Text style={styles.oauthText}>Continue with Google</Text>
        </Pressable>

        {appleAvailable && Platform.OS === "ios" && (
          <AppleAuthentication.AppleAuthenticationButton
            buttonType={AppleAuthentication.AppleAuthenticationButtonType.SIGN_IN}
            buttonStyle={AppleAuthentication.AppleAuthenticationButtonStyle.WHITE}
            cornerRadius={R.md}
            style={styles.apple}
            onPress={() =>
              run(async () => {
                const r = await signInWithApple();
                return r ? exchangeAppleIdToken(r.idToken, r.fullName, r.email) : null;
              })
            }
          />
        )}
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: C.bg },
  scroll: { flexGrow: 1, padding: 24, justifyContent: "center" },
  logoWrap: { alignItems: "center", marginBottom: 16 },
  logo: {
    width: 68,
    height: 68,
    borderRadius: 22,
    backgroundColor: C.go,
    alignItems: "center",
    justifyContent: "center",
    transform: [{ rotate: "-8deg" }],
  },
  brand: { color: C.text, fontSize: 34, fontWeight: "900", textAlign: "center", letterSpacing: -0.5 },
  subtitle: { color: C.go, fontSize: 13, fontWeight: "900", textAlign: "center", letterSpacing: 6, marginTop: 2 },
  tagline: { color: C.textDim, fontSize: 15, textAlign: "center", marginTop: 14, marginBottom: 28 },
  field: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    backgroundColor: C.surface,
    borderRadius: R.md,
    borderWidth: 1,
    borderColor: C.border,
    paddingHorizontal: 14,
    height: 54,
    marginBottom: 12,
  },
  input: { flex: 1, color: C.text, fontSize: 16, height: "100%" },
  orRow: { flexDirection: "row", alignItems: "center", gap: 12, marginVertical: 20 },
  orLine: { flex: 1, height: StyleSheet.hairlineWidth, backgroundColor: C.border },
  orText: { color: C.textMute, fontWeight: "700" },
  oauth: {
    flexDirection: "row",
    gap: 10,
    backgroundColor: C.text,
    borderRadius: R.md,
    height: 52,
    alignItems: "center",
    justifyContent: "center",
  },
  oauthText: { color: C.bg, fontWeight: "800", fontSize: 15 },
  apple: { height: 52, marginTop: 12 },
});
