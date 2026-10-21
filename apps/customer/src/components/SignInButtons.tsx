import { Ionicons } from "@expo/vector-icons";
import { useEffect, useState } from "react";
import { ActivityIndicator, Alert, Pressable, StyleSheet, Text, View } from "react-native";
import { availableProviders, type Provider, signIn, SignInCancelled } from "../auth";
import { colors, radius } from "../theme";

// Apple's own button (guideline 4.8 and Apple's HIG want it, not a lookalike)
// above Google's white one. Renders nothing when the build offers neither.
export function SignInButtons() {
  const [providers, setProviders] = useState<Provider[] | null>(null);
  const [busy, setBusy] = useState<Provider | null>(null);

  useEffect(() => {
    availableProviders().then(setProviders);
  }, []);

  if (!providers?.length) return null;

  const run = async (provider: Provider) => {
    if (busy) return;
    setBusy(provider);
    try {
      await signIn(provider);
    } catch (err: any) {
      if (!(err instanceof SignInCancelled)) {
        Alert.alert("Couldn't sign you in", err?.message ?? "Please try again.");
      }
    } finally {
      setBusy(null);
    }
  };

  // Lazily, like src/auth.ts: absent from builds made before it was added.
  const apple = providers.includes("apple") ? require("expo-apple-authentication") : null;

  return (
    <View style={styles.wrap}>
      {apple ? (
        <apple.AppleAuthenticationButton
          buttonType={apple.AppleAuthenticationButtonType.CONTINUE}
          buttonStyle={apple.AppleAuthenticationButtonStyle.BLACK}
          cornerRadius={radius.button}
          style={styles.button}
          onPress={() => run("apple")}
        />
      ) : null}
      {providers.includes("google") ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Continue with Google"
          onPress={() => run("google")}
          style={({ pressed }) => [styles.button, styles.google, pressed && { opacity: 0.7 }]}
        >
          {busy === "google" ? (
            <ActivityIndicator color={colors.text} />
          ) : (
            <>
              <Ionicons name="logo-google" size={18} color={colors.text} />
              <Text style={styles.googleLabel}>Continue with Google</Text>
            </>
          )}
        </Pressable>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: 10, padding: 16 },
  button: { height: 48, width: "100%" },
  google: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 10,
    borderRadius: radius.button,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.card,
  },
  googleLabel: { fontSize: 16, fontWeight: "600", color: colors.text },
});
