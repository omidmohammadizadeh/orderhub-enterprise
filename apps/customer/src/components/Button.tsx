import { ActivityIndicator, Pressable, StyleSheet, Text, type ViewStyle } from "react-native";
import { colors, radius } from "../theme";

type Props = {
  title: string;
  onPress: () => void;
  variant?: "primary" | "secondary";
  loading?: boolean;
  style?: ViewStyle;
};

export function Button({ title, onPress, variant = "primary", loading, style }: Props) {
  const primary = variant === "primary";
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      disabled={loading}
      style={({ pressed }) => [
        styles.base,
        primary ? { backgroundColor: colors.primary } : styles.secondary,
        pressed && { opacity: 0.85, transform: [{ scale: 0.98 }] },
        style,
      ]}
    >
      {loading ? (
        <ActivityIndicator color={primary ? colors.onPrimary : colors.primary} />
      ) : (
        <Text style={[styles.label, { color: primary ? colors.onPrimary : colors.primary }]}>{title}</Text>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  base: {
    minHeight: 52,
    borderRadius: radius.button,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 20,
  },
  secondary: { backgroundColor: colors.card, borderWidth: 1, borderColor: colors.border },
  label: { fontSize: 16, fontWeight: "700" },
});
