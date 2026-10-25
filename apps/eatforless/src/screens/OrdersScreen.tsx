// Orders — live ones first (tap to track), then past orders.

import { useNavigation } from "@react-navigation/native";
import { FlatList, RefreshControl, StyleSheet, View } from "react-native";
import Animated from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { isFinished, useMyOrders } from "@/api/hooks";
import type { OrderSummary } from "@/api/types";
import { useSession } from "@/auth/session";
import { TagMark } from "@/components/Bits";
import { Icon } from "@/components/Icon";
import { Photo } from "@/components/Photo";
import { PressScale } from "@/components/PressScale";
import { T } from "@/components/T";
import { foodKind } from "@/lib/menu";
import { money } from "@/lib/money";
import { fadeUp, stagger } from "@/lib/motion";
import { C, F } from "@/theme";

const STATUS: Record<string, string> = {
  PENDING: "Waiting for payment",
  RECEIVED: "Sent to the shop",
  ACCEPTED: "Accepted",
  PREPARING: "Preparing",
  READY: "Ready",
  OUT_FOR_DELIVERY: "On the way",
  RIDER_ARRIVED: "Driver at your door",
  DELIVERED: "Delivered",
  COLLECTED: "Collected",
  COMPLETED: "Completed",
  CANCELLED: "Cancelled",
  REJECTED: "Cancelled by the shop",
  FAILED: "Failed",
};

const when = (iso: string) =>
  new Date(iso).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" });

export function OrdersScreen() {
  const nav = useNavigation();
  const insets = useSafeAreaInsets();
  const signedIn = useSession((s) => !!s.token);
  const q = useMyOrders();
  const orders = q.data ?? [];

  if (!signedIn) {
    return (
      <View style={[styles.root, { paddingTop: insets.top + 16 }]}>
        <T v="hero" style={{ paddingHorizontal: 16 }}>Orders</T>
        <Animated.View entering={fadeUp(60)} style={styles.empty}>
          <TagMark size={56} />
          <T v="h3">Sign in to see your orders</T>
          <PressScale onPress={() => nav.navigate("Welcome")} style={styles.primary}>
            <T style={styles.primaryText}>Sign in</T>
          </PressScale>
        </Animated.View>
      </View>
    );
  }

  const renderItem = ({ item, index }: { item: OrderSummary; index: number }) => {
    const liveNow = !isFinished(item.status);
    const name = item.brand?.name ?? item.location?.name ?? "Order";
    return (
      <Animated.View entering={fadeUp(stagger(index, 50, 40), 12, 500)}>
        <PressScale onPress={() => nav.navigate("Tracking", { orderId: item.id })} style={[styles.row, liveNow && styles.rowLive]} scaleTo={0.98}>
          <Photo kind={foodKind(name)} radius={14} style={{ width: 60, height: 60 }} />
          <View style={{ flex: 1, gap: 3 }}>
            <T v="item">{name}</T>
            <T v="sub">{when(item.createdAt)} · {money(item.total)}{item.displayId ? ` · #${item.displayId}` : ""}</T>
            <View style={styles.statusRow}>
              {liveNow ? <View style={styles.liveDot} /> : null}
              <T style={[styles.status, liveNow && { color: C.ink }]}>{STATUS[item.status] ?? item.status}</T>
            </View>
          </View>
          <Icon name="chevronRight" size={18} color={C.grey500} />
        </PressScale>
      </Animated.View>
    );
  };

  return (
    <View style={[styles.root, { paddingTop: insets.top + 16 }]}>
      <FlatList
        data={orders}
        keyExtractor={(o) => o.id}
        renderItem={renderItem}
        contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 140, gap: 10 }}
        refreshControl={<RefreshControl refreshing={q.isRefetching} onRefresh={() => q.refetch()} tintColor={C.ink} />}
        ListHeaderComponent={<T v="hero" style={{ marginBottom: 8 }}>Orders</T>}
        ListEmptyComponent={
          q.isLoading ? (
            <T v="sub">Loading…</T>
          ) : (
            <Animated.View entering={fadeUp(60)} style={[styles.empty, { paddingHorizontal: 0 }]}>
              <TagMark size={56} />
              <T v="h3">No orders yet</T>
              <T v="sub" style={{ textAlign: "center", fontSize: 15 }}>Your first Eat For Less order will show up here.</T>
              <PressScale onPress={() => nav.navigate("Tabs", { screen: "Home" })} style={styles.primary}>
                <T style={styles.primaryText}>Find food</T>
              </PressScale>
            </Animated.View>
          )
        }
      />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: C.white },
  row: { flexDirection: "row", alignItems: "center", gap: 12, padding: 12, borderRadius: 18, borderWidth: 1, borderColor: C.grey200 },
  rowLive: { borderColor: C.ink, borderWidth: 2 },
  statusRow: { flexDirection: "row", alignItems: "center", gap: 6 },
  liveDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: "#3BB54A" },
  status: { fontFamily: F.semibold, fontSize: 13, color: C.grey600 },
  empty: { alignItems: "center", gap: 12, paddingHorizontal: 32, paddingTop: 60 },
  primary: { marginTop: 8, height: 48, borderRadius: 24, backgroundColor: C.ink, paddingHorizontal: 24, justifyContent: "center" },
  primaryText: { color: C.white, fontFamily: F.bold, fontSize: 15 },
});
