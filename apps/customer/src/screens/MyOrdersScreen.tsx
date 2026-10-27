import { Ionicons } from "@expo/vector-icons";
import { useState } from "react";
import { ActivityIndicator, FlatList, Pressable, StyleSheet, Text, View } from "react-native";
import { slugFromUrl } from "../storefront-bridge";
import { brand, withBrandQuery } from "../brand";
import { Button } from "../components/Button";
import { Card } from "../components/Card";
import { StatusPill } from "../components/StatusPill";
import { dateTime, money, orderLabel } from "../format";
import { openOrder, openStorefront } from "../navigation";
import { type SavedOrder, useSavedOrders } from "../orders";
import { colors } from "../theme";
import { useOrderStatus } from "../useOrderStatus";

export function MyOrdersScreen() {
  const orders = useSavedOrders();
  // Bumping the key remounts the rows, which refetches every status.
  const [generation, setGeneration] = useState(0);
  const slug = slugFromUrl(brand.storefrontUrl);
  const accountHistory = () => openStorefront(withBrandQuery(`/order/${slug}/my-orders`));

  if (!orders) {
    return (
      <View style={styles.center}>
        <ActivityIndicator color={colors.primary} />
      </View>
    );
  }

  return (
    <FlatList
      style={styles.root}
      contentContainerStyle={styles.content}
      data={orders}
      keyExtractor={(o) => `${o.orderId}:${generation}`}
      refreshing={false}
      onRefresh={() => setGeneration((g) => g + 1)}
      renderItem={({ item }) => <OrderRow saved={item} />}
      ListEmptyComponent={
        <View style={styles.empty}>
          <Ionicons name="receipt-outline" size={44} color={colors.muted} />
          <Text style={styles.emptyTitle}>No orders yet</Text>
          <Text style={styles.muted}>Orders you place in this app show up here, with live updates.</Text>
        </View>
      }
      ListFooterComponent={
        <Button title="Order history on your account" variant="secondary" onPress={accountHistory} style={{ marginTop: 8 }} />
      }
    />
  );
}

function OrderRow({ saved }: { saved: SavedOrder }) {
  const { order, error } = useOrderStatus(saved.orderId, { poll: false });
  return (
    <Pressable onPress={() => openOrder(saved.orderId, saved.slug)}>
      <Card style={styles.row}>
        <View style={{ flex: 1, gap: 6 }}>
          <Text style={styles.rowTitle}>
            {order ? `${order.location?.name ?? brand.name} ${orderLabel(order)}` : brand.name}
          </Text>
          {order ? (
            <>
              <StatusPill order={order} />
              <Text style={styles.muted}>
                {dateTime(order.receivedAt ?? new Date(saved.savedAt).toISOString())} ·{" "}
                {money(order.total, order.location?.currency)}
              </Text>
            </>
          ) : (
            <Text style={styles.muted}>{error ? "Couldn't load this order" : "Loading…"}</Text>
          )}
        </View>
        <Ionicons name="chevron-forward" size={20} color={colors.muted} />
      </Card>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.background },
  content: { padding: 16, gap: 12, flexGrow: 1 },
  center: { flex: 1, alignItems: "center", justifyContent: "center" },
  row: { flexDirection: "row", alignItems: "center", gap: 8 },
  rowTitle: { fontSize: 16, fontWeight: "700", color: colors.text },
  muted: { fontSize: 14, color: colors.muted, textAlign: "left" },
  empty: { alignItems: "center", paddingVertical: 48, gap: 8, paddingHorizontal: 24 },
  emptyTitle: { fontSize: 18, fontWeight: "700", color: colors.text },
});
