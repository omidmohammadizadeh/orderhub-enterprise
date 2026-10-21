import { Ionicons } from "@expo/vector-icons";
import { Pressable, StyleSheet, Text, View, type ViewStyle } from "react-native";
import { type Access, useAccess } from "../permissions";
import { colors, radius } from "../theme";

type Ask = {
  key: string;
  icon: keyof typeof Ionicons.glyphMap;
  title: string;
  detail: string;
  access: Access;
  onPress: () => void;
};

/**
 * Notifications (and, in a multi-shop app, location) turned off: a banner
 * that stays until they're on. "Allow" asks the phone when it still can,
 * and opens this app's Settings page once the customer has said no.
 */
export function AccessBanner({ style, notificationsOnly }: { style?: ViewStyle; notificationsOnly?: boolean }) {
  const a = useAccess();
  const asks: Ask[] = [];
  if (a.notifications && a.notifications !== "on") {
    asks.push({
      key: "notifications",
      icon: "notifications",
      title: "Turn on order updates",
      detail: "Know the moment your order is accepted, ready and at your door.",
      access: a.notifications,
      onPress: a.allowNotifications,
    });
  }
  if (!notificationsOnly && a.location && a.location !== "on") {
    asks.push({
      key: "location",
      icon: "location",
      title: "Find your nearest shop",
      detail: "Allow location so we can show the shop closest to you.",
      access: a.location,
      onPress: a.allowLocation,
    });
  }
  if (!asks.length) return null;

  return (
    <View style={[{ gap: 10 }, style]}>
      {asks.map((ask) => (
        <View key={ask.key} style={styles.banner} accessibilityRole="summary">
          <View style={styles.icon}>
            <Ionicons name={ask.icon} size={20} color={colors.primary} />
          </View>
          <View style={{ flex: 1 }}>
            <Text style={styles.title}>{ask.title}</Text>
            <Text style={styles.detail}>{ask.detail}</Text>
          </View>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={ask.access === "settings" ? `${ask.title}: open Settings` : `${ask.title}: allow`}
            onPress={ask.onPress}
            hitSlop={8}
            style={({ pressed }) => [styles.button, pressed && { opacity: 0.85, transform: [{ scale: 0.96 }] }]}
          >
            <Text style={styles.buttonText}>{ask.access === "settings" ? "Settings" : "Allow"}</Text>
          </Pressable>
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  banner: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    padding: 14,
    borderRadius: radius.card,
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.border,
  },
  icon: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: `${colors.primary}14`,
  },
  title: { fontSize: 15, fontWeight: "700", color: colors.text },
  detail: { fontSize: 13, color: colors.muted, marginTop: 2, lineHeight: 18 },
  button: {
    minHeight: 40,
    paddingHorizontal: 16,
    borderRadius: radius.chip,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.primary,
  },
  buttonText: { color: colors.onPrimary, fontSize: 14, fontWeight: "800" },
});
