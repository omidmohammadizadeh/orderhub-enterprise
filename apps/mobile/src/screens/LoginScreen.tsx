import React, { useEffect, useState } from "react";
import {
  ActivityIndicator,
  Image,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import * as AppleAuthentication from "expo-apple-authentication";

import {
  exchangeAppleIdToken,
  exchangeGoogleIdToken,
  loginWithEmailPassword,
} from "@/services/auth";
import { signInWithGoogle } from "@/services/google";
import { isAppleSignInAvailable, signInWithApple } from "@/services/apple";

interface Props {
  onSignedIn: (jwt: string) => void;
}

export function LoginScreen({ onSignedIn }: Props) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [appleAvailable, setAppleAvailable] = useState(false);

  useEffect(() => {
    isAppleSignInAvailable().then(setAppleAvailable);
  }, []);

  const handleEmailLogin = async () => {
    if (!email.trim() || !password) {
      setError("Email and password are required");
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const jwt = await loginWithEmailPassword(email.trim(), password);
      onSignedIn(jwt);
    } catch (err: any) {
      setError(
        err?.response?.data?.message ?? err?.message ?? "Sign-in failed",
      );
    } finally {
      setSubmitting(false);
    }
  };

  const handleGoogle = async () => {
    setSubmitting(true);
    setError(null);
    try {
      const idToken = await signInWithGoogle();
      if (!idToken) return; // user cancelled
      const jwt = await exchangeGoogleIdToken(idToken);
      onSignedIn(jwt);
    } catch (err: any) {
      setError(err?.message ?? "Google sign-in failed");
    } finally {
      setSubmitting(false);
    }
  };

  const handleApple = async () => {
    setSubmitting(true);
    setError(null);
    try {
      const result = await signInWithApple();
      if (!result) return; // user cancelled
      const jwt = await exchangeAppleIdToken(
        result.idToken,
        result.fullName,
        result.email,
      );
      onSignedIn(jwt);
    } catch (err: any) {
      setError(err?.message ?? "Apple sign-in failed");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <SafeAreaView style={styles.container} edges={["top", "bottom"]}>
      <KeyboardAvoidingView
        behavior={Platform.OS === "ios" ? "padding" : undefined}
        style={styles.flex}
      >
        <View style={styles.inner}>
          <Image
            source={require("../../assets/icon.png")}
            style={styles.logo}
            resizeMode="contain"
          />
          <Text style={styles.title}>Order Hub Solutions</Text>
          <Text style={styles.subtitle}>Sign in to your point-of-sale</Text>

          <TextInput
            value={email}
            onChangeText={setEmail}
            placeholder="Email"
            placeholderTextColor="#71717A"
            autoCapitalize="none"
            keyboardType="email-address"
            autoComplete="email"
            style={styles.input}
            editable={!submitting}
          />
          <TextInput
            value={password}
            onChangeText={setPassword}
            placeholder="Password"
            placeholderTextColor="#71717A"
            secureTextEntry
            autoComplete="current-password"
            style={styles.input}
            editable={!submitting}
          />

          {error && <Text style={styles.error}>{error}</Text>}

          <Pressable
            onPress={handleEmailLogin}
            disabled={submitting}
            style={({ pressed }) => [
              styles.primaryButton,
              pressed && styles.pressed,
              submitting && styles.disabled,
            ]}
          >
            {submitting ? (
              <ActivityIndicator color="#FFFFFF" />
            ) : (
              <Text style={styles.primaryButtonText}>Sign in</Text>
            )}
          </Pressable>

          <View style={styles.dividerRow}>
            <View style={styles.divider} />
            <Text style={styles.dividerText}>or continue with</Text>
            <View style={styles.divider} />
          </View>

          <Pressable
            onPress={handleGoogle}
            disabled={submitting}
            style={({ pressed }) => [
              styles.googleButton,
              pressed && styles.pressed,
              submitting && styles.disabled,
            ]}
          >
            <Text style={styles.googleButtonText}>Continue with Google</Text>
          </Pressable>

          {appleAvailable && (
            <AppleAuthentication.AppleAuthenticationButton
              buttonType={
                AppleAuthentication.AppleAuthenticationButtonType.SIGN_IN
              }
              buttonStyle={
                AppleAuthentication.AppleAuthenticationButtonStyle.BLACK
              }
              cornerRadius={10}
              style={styles.appleButton}
              onPress={handleApple}
            />
          )}
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#0F172A" },
  flex: { flex: 1 },
  inner: {
    flex: 1,
    padding: 24,
    justifyContent: "center",
    maxWidth: 420,
    width: "100%",
    alignSelf: "center",
  },
  logo: { width: 80, height: 80, alignSelf: "center", marginBottom: 16 },
  title: {
    color: "#FFFFFF",
    fontSize: 24,
    fontWeight: "700",
    textAlign: "center",
  },
  subtitle: {
    color: "#94A3B8",
    fontSize: 14,
    textAlign: "center",
    marginTop: 4,
    marginBottom: 32,
  },
  input: {
    backgroundColor: "#1E293B",
    color: "#FFFFFF",
    paddingHorizontal: 14,
    paddingVertical: 14,
    borderRadius: 10,
    marginBottom: 12,
    fontSize: 16,
  },
  error: {
    color: "#F87171",
    fontSize: 13,
    marginBottom: 12,
  },
  primaryButton: {
    backgroundColor: "#F97316",
    paddingVertical: 14,
    borderRadius: 10,
    alignItems: "center",
  },
  primaryButtonText: {
    color: "#FFFFFF",
    fontSize: 16,
    fontWeight: "600",
  },
  dividerRow: {
    flexDirection: "row",
    alignItems: "center",
    marginVertical: 24,
  },
  divider: { flex: 1, height: 1, backgroundColor: "#334155" },
  dividerText: { color: "#94A3B8", paddingHorizontal: 12, fontSize: 12 },
  googleButton: {
    backgroundColor: "#FFFFFF",
    paddingVertical: 14,
    borderRadius: 10,
    alignItems: "center",
    marginBottom: 12,
  },
  googleButtonText: { color: "#0F172A", fontSize: 15, fontWeight: "600" },
  appleButton: { width: "100%", height: 48 },
  pressed: { opacity: 0.85 },
  disabled: { opacity: 0.5 },
});
