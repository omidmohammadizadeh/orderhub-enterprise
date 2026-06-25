import { useEffect, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import * as AppleAuthentication from "expo-apple-authentication";
import {
  AuthTokens,
  exchangeAppleIdToken,
  exchangeGoogleIdToken,
  loginWithEmailPassword,
} from "@/services/auth";
import { signInWithGoogle } from "@/services/google";
import { isAppleSignInAvailable, signInWithApple } from "@/services/apple";

export function LoginScreen({ onSignedIn }: { onSignedIn: (t: AuthTokens) => void }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
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
      Alert.alert("Sign-in failed", (err as Error)?.message ?? "Please try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <View style={styles.container}>
      <Text style={styles.brand}>Order Hub</Text>
      <Text style={styles.subtitle}>Driver</Text>

      <TextInput
        style={styles.input}
        placeholder="Email"
        placeholderTextColor="#94a3b8"
        autoCapitalize="none"
        keyboardType="email-address"
        value={email}
        onChangeText={setEmail}
      />
      <TextInput
        style={styles.input}
        placeholder="Password"
        placeholderTextColor="#94a3b8"
        secureTextEntry
        value={password}
        onChangeText={setPassword}
      />

      <Pressable
        style={[styles.primary, busy && { opacity: 0.6 }]}
        disabled={busy}
        onPress={() => run(() => loginWithEmailPassword(email.trim(), password))}
      >
        {busy ? <ActivityIndicator color="#fff" /> : <Text style={styles.primaryText}>Sign in</Text>}
      </Pressable>

      <Pressable
        style={styles.oauth}
        disabled={busy}
        onPress={() =>
          run(async () => {
            const idToken = await signInWithGoogle();
            return idToken ? exchangeGoogleIdToken(idToken) : null;
          })
        }
      >
        <Text style={styles.oauthText}>Continue with Google</Text>
      </Pressable>

      {appleAvailable && Platform.OS === "ios" && (
        <AppleAuthentication.AppleAuthenticationButton
          buttonType={AppleAuthentication.AppleAuthenticationButtonType.SIGN_IN}
          buttonStyle={AppleAuthentication.AppleAuthenticationButtonStyle.BLACK}
          cornerRadius={10}
          style={styles.apple}
          onPress={() =>
            run(async () => {
              const r = await signInWithApple();
              return r ? exchangeAppleIdToken(r.idToken, r.fullName, r.email) : null;
            })
          }
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: 24, justifyContent: "center", backgroundColor: "#0F172A" },
  brand: { color: "#fff", fontSize: 34, fontWeight: "800", textAlign: "center" },
  subtitle: { color: "#f97316", fontSize: 18, fontWeight: "700", textAlign: "center", marginBottom: 28 },
  input: {
    backgroundColor: "#1e293b",
    color: "#fff",
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 14,
    marginBottom: 12,
    fontSize: 16,
  },
  primary: {
    backgroundColor: "#f97316",
    borderRadius: 10,
    paddingVertical: 15,
    alignItems: "center",
    marginTop: 4,
  },
  primaryText: { color: "#fff", fontWeight: "800", fontSize: 16 },
  oauth: {
    backgroundColor: "#fff",
    borderRadius: 10,
    paddingVertical: 14,
    alignItems: "center",
    marginTop: 12,
  },
  oauthText: { color: "#0F172A", fontWeight: "700", fontSize: 15 },
  apple: { height: 48, marginTop: 12 },
});
