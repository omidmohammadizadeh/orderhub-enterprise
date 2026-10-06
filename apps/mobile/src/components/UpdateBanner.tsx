// "A new version is ready" — the over-the-air update prompt.
//
// WHY THIS EXISTS. On 4 Oct 2026 two Just Eat orders landed at Jinty's 0.4 s
// apart and their receipts came out as a metre of garbage: two print jobs
// interleaved on one Bluetooth socket. Half the fix was web and went live the
// same hour; the other half was React Native and sat in the repo, because the
// app had no updater and nobody had reinstalled it. On 6 Oct it shredded again,
// same shop, same cause. This component is how that half reaches a till without
// anyone being told to go and update anything.
//
// TWO RULES FOR A TILL
//
// 1. NEVER RELOAD BY ITSELF. expo-updates downloads in the background, and
//    applying means tearing down the WebView — mid-order that loses the basket.
//    So the update waits here until someone taps, and "Later" is always there.
//    It costs us a service to land a fix and that is the right trade.
// 2. NEVER BLOCK THE LAUNCH. `fallbackToCacheTimeout: 0` in app.json means a
//    slow connection can't delay a till starting up. If the download isn't
//    ready, this renders nothing and tries again next launch.
//
// Native builds (new permissions, new native modules) can't ship this way —
// `runtimeVersion.policy: "fingerprint"` makes Expo refuse to hand a JS bundle
// to a binary whose native layer doesn't match, which is exactly what we want:
// no update is better than one that half-applies.

import React, { useState } from "react";
import {
  ActivityIndicator,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import * as Updates from "expo-updates";
import { useUpdates } from "expo-updates";

export function UpdateBanner(): React.ReactElement | null {
  const { isUpdatePending } = useUpdates();
  const [dismissed, setDismissed] = useState(false);
  const [applying, setApplying] = useState(false);
  const insets = useSafeAreaInsets();

  // Updates are disabled in dev and in Expo Go; the hook still renders, so
  // guard rather than show a banner that cannot do anything.
  if (!Updates.isEnabled || !isUpdatePending || dismissed) return null;

  const apply = async () => {
    setApplying(true);
    try {
      await Updates.reloadAsync();
    } catch {
      // A failed reload must not leave the till staring at a dead spinner —
      // the update is still downloaded and will apply on the next launch.
      setApplying(false);
      setDismissed(true);
    }
  };

  return (
    <View
      style={[styles.wrap, { bottom: insets.bottom + 16 }]}
      pointerEvents="box-none"
      accessibilityRole="alert"
    >
      <View style={styles.card}>
        <View style={styles.dot} />
        <View style={styles.copy}>
          <Text style={styles.title}>A new version is ready</Text>
          <Text style={styles.subtitle}>
            Takes a few seconds. Best done between orders.
          </Text>
        </View>

        <Pressable
          onPress={() => setDismissed(true)}
          disabled={applying}
          style={({ pressed }) => [styles.later, pressed && styles.pressed]}
          accessibilityRole="button"
          accessibilityLabel="Update later"
        >
          <Text style={styles.laterText}>Later</Text>
        </Pressable>

        <Pressable
          onPress={apply}
          disabled={applying}
          style={({ pressed }) => [styles.cta, pressed && styles.pressed]}
          accessibilityRole="button"
          accessibilityLabel="Update now"
        >
          {applying ? (
            <ActivityIndicator color="#0F172A" size="small" />
          ) : (
            <Text style={styles.ctaText}>Update now</Text>
          )}
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    position: "absolute",
    left: 0,
    right: 0,
    alignItems: "center",
    // Above the WebView, below nothing else — the till has no other overlay.
    zIndex: 1000,
  },
  card: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    maxWidth: 560,
    paddingVertical: 12,
    paddingHorizontal: 16,
    marginHorizontal: 16,
    borderRadius: 14,
    backgroundColor: "#0F172A",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.12)",
    ...Platform.select({
      ios: {
        shadowColor: "#000",
        shadowOpacity: 0.35,
        shadowRadius: 18,
        shadowOffset: { width: 0, height: 8 },
      },
      android: { elevation: 10 },
    }),
  },
  dot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: "#F97316",
  },
  copy: { flexShrink: 1 },
  title: { color: "#F8FAFC", fontSize: 15, fontWeight: "600" },
  subtitle: { color: "#94A3B8", fontSize: 13, marginTop: 2 },
  later: { paddingVertical: 8, paddingHorizontal: 12, borderRadius: 10 },
  laterText: { color: "#94A3B8", fontSize: 14, fontWeight: "500" },
  cta: {
    minWidth: 112,
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: 10,
    paddingHorizontal: 16,
    borderRadius: 10,
    backgroundColor: "#F97316",
  },
  ctaText: { color: "#0F172A", fontSize: 14, fontWeight: "700" },
  pressed: { opacity: 0.85 },
});
