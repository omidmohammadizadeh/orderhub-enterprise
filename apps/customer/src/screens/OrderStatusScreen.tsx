import { Ionicons } from "@expo/vector-icons";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import * as Linking from "expo-linking";
import { useLayoutEffect } from "react";
import { ActivityIndicator, RefreshControl, ScrollView, StyleSheet, Text, View } from "react-native";
import { Button } from "../components/Button";
import { Card } from "../components/Card";
import { dateTime, headline, isDelivery, isFailed, isFinished, money, orderLabel, progress, time } from "../format";
import { openStorefront, type RootParams } from "../navigation";
import { trackPathFor } from "../push";
import { colors } from "../theme";
import { useOrderStatus } from "../useOrderStatus";

type Props = NativeStackScreenProps<RootParams, "OrderStatus">;

export function OrderStatusScreen({ route, navigation }: Props) {
  const { orderId, slug } = route.params;
  const { order, error, refreshing, refresh } = useOrderStatus(orderId);

  useLayoutEffect(() => {
    navigation.setOptions({ title: order ? `Order ${orderLabel(order)}` : "Your order" });
  }, [navigation, order]);

  if (!order) {
    return (
      <View style={styles.center}>
        {error ? (
          <>
            <Text style={styles.muted}>We couldn't load this order.</Text>
            <Button title="Try again" onPress={refresh} style={{ marginTop: 16, alignSelf: "stretch" }} />
            <Button
              title="View on the website"
              variant="secondary"
              onPress={() => openStorefront(trackPathFor(slug, orderId))}
              style={{ marginTop: 10, alignSelf: "stretch" }}
            />
          </>
        ) : (
          <ActivityIndicator color={colors.primary} />
        )}
      </View>
    );
  }

  const { steps, current } = progress(order);
  const failed = isFailed(order.status);
  const finished = isFinished(order.status);
  const eta = order.scheduledFor ?? order.estimatedReadyAt;
  const currency = order.location?.currency;

  return (
    <ScrollView
      style={styles.root}
      contentContainerStyle={styles.content}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refresh} tintColor={colors.primary} />}
    >
      <Card>
        <Text style={styles.place}>{order.location?.name}</Text>
        <Text style={[styles.headline, failed && { color: colors.danger }]}>{headline(order)}</Text>
        {!finished && eta ? (
          <Text style={styles.eta}>
            {order.scheduledFor ? "Scheduled for " : isDelivery(order.fulfillmentType) ? "Estimated arrival " : "Ready around "}
            <Text style={styles.etaTime}>{order.scheduledFor ? dateTime(eta) : time(eta)}</Text>
          </Text>
        ) : null}
        {failed && order.cancelReason ? <Text style={styles.muted}>{order.cancelReason}</Text> : null}

        {!failed ? (
          <View style={styles.steps}>
            {steps.map((label, i) => {
              const done = i < current || (finished && i === current);
              const now = i === current && !finished;
              return (
                <View key={label} style={styles.step}>
                  <View style={styles.rail}>
                    <View
                      style={[
                        styles.node,
                        (done || now) && { backgroundColor: colors.primary, borderColor: colors.primary },
                      ]}
                    >
                      {done ? <Ionicons name="checkmark" size={12} color={colors.onPrimary} /> : null}
                    </View>
                    {i < steps.length - 1 ? (
                      <View style={[styles.line, i < current && { backgroundColor: colors.primary }]} />
                    ) : null}
                  </View>
                  <Text style={[styles.stepLabel, (done || now) && styles.stepLabelOn]}>{label}</Text>
                </View>
              );
            })}
          </View>
        ) : null}
      </Card>

      {order.driver ? (
        <Card style={styles.row}>
          <Ionicons name="bicycle" size={26} color={colors.primary} />
          <View style={{ flex: 1 }}>
            <Text style={styles.cardTitle}>{order.driver.name} is delivering your order</Text>
          </View>
          {order.driver.phone ? (
            <Button
              title="Call"
              variant="secondary"
              onPress={() => Linking.openURL(`tel:${order.driver!.phone}`)}
              style={{ minHeight: 40 }}
            />
          ) : null}
        </Card>
      ) : null}

      <Card>
        <Text style={styles.cardTitle}>Your order {orderLabel(order)}</Text>
        {order.items.map((it) => (
          <View key={it.id} style={styles.item}>
            <Text style={styles.qty}>{it.quantity}×</Text>
            <Text style={styles.itemName}>{it.name}</Text>
          </View>
        ))}
        <View style={styles.total}>
          <Text style={styles.totalLabel}>Total</Text>
          <Text style={styles.totalValue}>{money(order.total, currency)}</Text>
        </View>
        {order.receivedAt ? <Text style={styles.muted}>Placed {dateTime(order.receivedAt)}</Text> : null}
      </Card>

      <Button
        title="View on the website"
        variant="secondary"
        onPress={() => openStorefront(trackPathFor(slug, orderId))}
      />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.background },
  content: { padding: 16, gap: 12, paddingBottom: 40 },
  center: { flex: 1, alignItems: "center", justifyContent: "center", padding: 32, backgroundColor: colors.background },
  place: { fontSize: 14, color: colors.muted, fontWeight: "600" },
  headline: { fontSize: 24, fontWeight: "800", color: colors.text, marginTop: 4 },
  eta: { fontSize: 15, color: colors.muted, marginTop: 6 },
  etaTime: { color: colors.text, fontWeight: "700" },
  muted: { fontSize: 14, color: colors.muted, marginTop: 8 },
  steps: { marginTop: 20 },
  step: { flexDirection: "row", minHeight: 40 },
  rail: { width: 28, alignItems: "center" },
  node: {
    width: 20,
    height: 20,
    borderRadius: 10,
    borderWidth: 2,
    borderColor: colors.border,
    backgroundColor: colors.card,
    alignItems: "center",
    justifyContent: "center",
  },
  line: { flex: 1, width: 2, backgroundColor: colors.border, marginVertical: 2 },
  stepLabel: { fontSize: 15, color: colors.muted, marginLeft: 8, marginTop: 1 },
  stepLabelOn: { color: colors.text, fontWeight: "600" },
  row: { flexDirection: "row", alignItems: "center", gap: 12 },
  cardTitle: { fontSize: 16, fontWeight: "700", color: colors.text, marginBottom: 6 },
  item: { flexDirection: "row", paddingVertical: 4 },
  qty: { width: 32, fontSize: 15, color: colors.muted, fontWeight: "600" },
  itemName: { flex: 1, fontSize: 15, color: colors.text },
  total: {
    flexDirection: "row",
    justifyContent: "space-between",
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
    marginTop: 10,
    paddingTop: 10,
  },
  totalLabel: { fontSize: 16, fontWeight: "700", color: colors.text },
  totalValue: { fontSize: 16, fontWeight: "700", color: colors.text },
});
