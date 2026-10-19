import { Ionicons } from "@expo/vector-icons";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import * as Linking from "expo-linking";
import { type ComponentType, useEffect, useLayoutEffect, useRef, useState } from "react";
import { ActivityIndicator, Platform, RefreshControl, ScrollView, StyleSheet, Text, useWindowDimensions, View } from "react-native";
import { brand } from "../brand";
import { Button } from "../components/Button";
import { Card } from "../components/Card";
import { dateTime, headline, isDelivery, isFailed, isFinished, money, orderLabel, progress, time } from "../format";
import { openStorefront, type RootParams } from "../navigation";
import { trackPathFor } from "../push";
import { type LatLng, agoLabel, etaMinutes, milesBetween } from "../live-tracking";
import { colors, radius } from "../theme";
import { useOrderStatus } from "../useOrderStatus";

type Props = NativeStackScreenProps<RootParams, "OrderStatus">;

type MapProps = {
  driver: LatLng | null;
  destination: LatLng | null;
  shop: LatLng | null;
  bottomInset: number;
  arrived: boolean;
};

/** The live map, loaded only when needed and only where it can draw: every
 *  iOS build from 1.2.0, and Android builds that carry a Maps key. A build
 *  without the native module gets null and the card view instead. */
let LiveMap: ComponentType<MapProps> | null | undefined;
function liveMap(): ComponentType<MapProps> | null {
  if (LiveMap !== undefined) return LiveMap;
  if (Platform.OS === "android" && !brand.androidMap) return (LiveMap = null);
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    LiveMap = require("../components/LiveTrackingMap").LiveTrackingMap as ComponentType<MapProps>;
  } catch {
    LiveMap = null;
  }
  return LiveMap;
}

/** Re-renders every second, for "updated 4s ago" and the ETA clock. */
function useTick(on: boolean) {
  const [, set] = useState(0);
  useEffect(() => {
    if (!on) return;
    const t = setInterval(() => set((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [on]);
}

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

  // RIDER_ARRIVED before pickup means "at the shop"; only once the food
  // has left (outForDeliveryAt) is the driver on the way or at the door.
  const onTheWay =
    isDelivery(order.fulfillmentType) &&
    (order.status === "OUT_FOR_DELIVERY" || (order.status === "RIDER_ARRIVED" && !!order.outForDeliveryAt));
  if (onTheWay) {
    return <LiveDelivery order={order} slug={slug} orderId={orderId} refreshing={refreshing} refresh={refresh} />;
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

type LiveProps = {
  order: NonNullable<ReturnType<typeof useOrderStatus>["order"]>;
  slug: string;
  orderId: string;
  refreshing: boolean;
  refresh: () => void;
};

/** Out for delivery: the map takes the top of the screen, the live panel
 *  (arrival time, progress, driver, order) sits over the rest. */
function LiveDelivery({ order, slug, orderId, refreshing, refresh }: LiveProps) {
  const { height } = useWindowDimensions();
  useTick(true);
  const arrived = order.status === "RIDER_ARRIVED";
  const driverPos =
    order.driver?.lat != null && order.driver?.lng != null ? { lat: order.driver.lat, lng: order.driver.lng } : null;
  const destination = order.destination ?? null;
  const Map = driverPos || destination ? liveMap() : null;
  const mapHeight = Map ? Math.round(height * 0.5) : 0;

  // Progress along the route: how much of the first measured distance is done.
  const startMiles = useRef<number | null>(null);
  const miles = driverPos && destination ? milesBetween(driverPos, destination) : null;
  if (miles != null && (startMiles.current == null || miles > startMiles.current)) startMiles.current = miles;
  const done = arrived
    ? 1
    : miles != null && startMiles.current
      ? Math.min(0.97, Math.max(0.05, 1 - miles / startMiles.current))
      : 0.15;

  const mins = arrived ? 0 : driverPos && destination ? etaMinutes(driverPos, destination) : null;
  const arriveAt = mins != null ? new Date(Date.now() + mins * 60_000) : order.estimatedReadyAt ? new Date(order.estimatedReadyAt) : null;
  const driverName = order.driver?.name?.trim() || "Your driver";
  const ago = agoLabel(order.driver?.lastPingAt);
  const stale = order.driver?.lastPingAt ? Date.now() - new Date(order.driver.lastPingAt).getTime() > 2 * 60_000 : true;
  const currency = order.location?.currency;

  return (
    <View style={styles.root}>
      {Map ? (
        <View style={{ height: mapHeight + 24 }}>
          <Map driver={driverPos} destination={destination} shop={order.shop ?? null} bottomInset={24} arrived={arrived} />
        </View>
      ) : null}

      <ScrollView
        style={[styles.sheet, Map ? { marginTop: -24 } : null]}
        contentContainerStyle={styles.sheetContent}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refresh} tintColor={colors.primary} />}
      >
        {Map ? <View style={styles.handle} /> : null}

        <View style={styles.liveRow}>
          <View style={[styles.liveDot, (stale || !driverPos) && { backgroundColor: colors.muted }]} />
          <Text style={styles.liveText}>
            {arrived
              ? "At your door"
              : driverPos && !stale
                ? `Live · updated ${ago}`
                : driverPos && ago
                  ? `Last seen ${ago}`
                  : "On its way"}
          </Text>
        </View>

        <Text style={[styles.bigEta, arrived && { color: colors.success }]}>
          {arrived ? "Your driver is outside" : mins != null ? `Arriving in ${mins} min` : "On its way to you"}
        </Text>
        {!arrived && arriveAt ? (
          <Text style={styles.subEta}>
            Estimated arrival{" "}
            <Text style={styles.subEtaTime}>{time(arriveAt.toISOString())}</Text>
            {miles != null ? ` · ${miles < 0.1 ? "nearby" : `${miles.toFixed(1)} mi away`}` : ""}
          </Text>
        ) : null}
        {arrived ? <Text style={styles.subEta}>Head to the door to collect your order.</Text> : null}

        <View style={styles.track}>
          <View style={[styles.trackFill, { width: `${Math.round(done * 100)}%` }, arrived && { backgroundColor: colors.success }]} />
        </View>
        <View style={styles.trackLabels}>
          <Text style={styles.trackLabel}>{order.location?.name ?? "Restaurant"}</Text>
          <Text style={styles.trackLabel}>You</Text>
        </View>

        <View style={styles.driverCard}>
          <View style={styles.avatar}>
            <Text style={styles.avatarText}>{driverName.slice(0, 1).toUpperCase()}</Text>
          </View>
          <View style={{ flex: 1 }}>
            <Text style={styles.driverName}>{driverName}</Text>
            <Text style={styles.driverRole}>{arrived ? "Has arrived with your order" : "Delivering your order"}</Text>
          </View>
          {order.driver?.phone ? (
            <Button
              title="Call"
              onPress={() => Linking.openURL(`tel:${order.driver!.phone}`)}
              style={{ minHeight: 44, paddingHorizontal: 20 }}
            />
          ) : null}
        </View>

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
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.background },
  sheet: {
    flex: 1,
    backgroundColor: colors.background,
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
  },
  sheetContent: { padding: 20, paddingTop: 10, gap: 12, paddingBottom: 40 },
  handle: { alignSelf: "center", width: 40, height: 5, borderRadius: 3, backgroundColor: colors.border, marginBottom: 6 },
  liveRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  liveDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: colors.success },
  liveText: { fontSize: 13, fontWeight: "700", color: colors.muted, letterSpacing: 0.3, textTransform: "uppercase" },
  bigEta: { fontSize: 30, fontWeight: "800", color: colors.text, letterSpacing: -0.5 },
  subEta: { fontSize: 15, color: colors.muted, marginTop: -6 },
  subEtaTime: { color: colors.text, fontWeight: "700" },
  track: { height: 8, borderRadius: 4, backgroundColor: colors.border, overflow: "hidden", marginTop: 6 },
  trackFill: { height: 8, borderRadius: 4, backgroundColor: colors.primary },
  trackLabels: { flexDirection: "row", justifyContent: "space-between", marginTop: -4 },
  trackLabel: { fontSize: 12, color: colors.muted, fontWeight: "600" },
  driverCard: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    padding: 16,
    borderRadius: radius.card,
    backgroundColor: colors.card,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
  },
  avatar: {
    width: 48,
    height: 48,
    borderRadius: 24,
    backgroundColor: colors.primary,
    alignItems: "center",
    justifyContent: "center",
  },
  avatarText: { fontSize: 20, fontWeight: "800", color: colors.onPrimary },
  driverName: { fontSize: 17, fontWeight: "700", color: colors.text },
  driverRole: { fontSize: 14, color: colors.muted, marginTop: 2 },
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
