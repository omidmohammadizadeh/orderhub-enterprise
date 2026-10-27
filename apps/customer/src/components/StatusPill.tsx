import { StyleSheet, Text, View } from "react-native";
import type { OrderStatusPayload } from "../api";
import { headline, isFailed, isFinished } from "../format";
import { colors, radius } from "../theme";

export function StatusPill({ order }: { order: OrderStatusPayload }) {
  const failed = isFailed(order.status);
  const done = isFinished(order.status);
  const tint = failed ? colors.danger : done ? colors.success : colors.primary;
  return (
    <View style={[styles.pill, { backgroundColor: `${tint}1A` }]}>
      <View style={[styles.dot, { backgroundColor: tint }]} />
      <Text style={[styles.text, { color: tint }]} numberOfLines={1}>
        {headline(order)}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  pill: {
    flexDirection: "row",
    alignItems: "center",
    alignSelf: "flex-start",
    borderRadius: radius.chip,
    paddingHorizontal: 10,
    paddingVertical: 4,
    gap: 6,
    maxWidth: "100%",
  },
  dot: { width: 7, height: 7, borderRadius: 4 },
  text: { fontSize: 13, fontWeight: "600", flexShrink: 1 },
});
