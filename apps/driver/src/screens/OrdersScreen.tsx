import { useCallback, useEffect, useState } from "react";
import { ActivityIndicator, Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Job, getMyDay } from "@/services/auth";
import type { OrdersTab } from "@/components/Drawer";
import { Header, Icon, Segmented } from "@/components/ui";
import { C, R, mono, money } from "@/theme";

const PERIODS = [
  { key: "all", label: "All", days: 0 },
  { key: "today", label: "Today", days: 1 },
  { key: "7", label: "7 days", days: 7 },
  { key: "30", label: "30 days", days: 30 },
] as const;
type PeriodKey = (typeof PERIODS)[number]["key"];

const STATUS: Record<string, { label: string; color: string }> = {
  ASSIGNED: { label: "Assigned", color: C.info },
  ACCEPTED: { label: "Accepted", color: C.info },
  PICKED_UP: { label: "On the way", color: C.warn },
  DELIVERED: { label: "Delivered", color: C.go },
  CANCELLED: { label: "Cancelled", color: C.danger },
};

export function OrdersScreen({
  initialTab,
  onBack,
  onOpenJob,
}: {
  initialTab: OrdersTab;
  onBack: () => void;
  onOpenJob: (job: Job) => void;
}) {
  const insets = useSafeAreaInsets();
  const [tab, setTab] = useState<OrdersTab>(initialTab);
  const [period, setPeriod] = useState<PeriodKey>("all");
  const [active, setActive] = useState<Job[]>([]);
  const [history, setHistory] = useState<Job[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState(false);

  const load = useCallback(async () => {
    try {
      const d = await getMyDay();
      setActive(d.active);
      setHistory(d.history);
      setError(false);
    } catch {
      setError(true);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  function withinPeriod(j: Job): boolean {
    const days = PERIODS.find((p) => p.key === period)?.days ?? 0;
    if (!days) return true;
    const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
    return new Date(j.assignedAt).getTime() >= cutoff;
  }

  let list: Job[] = [];
  if (tab === "active") list = active;
  else if (tab === "delivered") list = history.filter((j) => j.status === "DELIVERED");
  else list = [...active, ...history].filter(withinPeriod);

  return (
    <View style={styles.container}>
      <Header title="Orders" subtitle={`${active.length} active · ${history.length} past`} onBack={onBack} />

      <View style={styles.controls}>
        <Segmented
          options={[
            { key: "active", label: "Active" },
            { key: "delivered", label: "Delivered" },
            { key: "history", label: "History" },
          ]}
          value={tab}
          onChange={setTab}
        />
        {tab === "history" && (
          <View style={styles.periods}>
            {PERIODS.map((p) => (
              <Pressable key={p.key} onPress={() => setPeriod(p.key)} style={[styles.period, period === p.key && styles.periodOn]}>
                <Text style={[styles.periodText, period === p.key && styles.periodTextOn]}>{p.label}</Text>
              </Pressable>
            ))}
          </View>
        )}
      </View>

      {loading ? (
        <View style={styles.center}>
          <ActivityIndicator color={C.textDim} />
        </View>
      ) : (
        <ScrollView
          style={{ flex: 1 }}
          contentContainerStyle={{ padding: 14, paddingBottom: Math.max(insets.bottom, 14) + 8, gap: 10 }}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              tintColor={C.textDim}
              colors={[C.go]}
              progressBackgroundColor={C.surface}
              onRefresh={() => {
                setRefreshing(true);
                load();
              }}
            />
          }
        >
          {error && <Text style={styles.error}>Couldn&apos;t load orders. Pull down to try again.</Text>}
          {list.length === 0 && !error && (
            <View style={styles.empty}>
              <Icon name="file-tray-outline" size={30} color={C.textMute} />
              <Text style={styles.emptyText}>No orders here</Text>
            </View>
          )}
          {list.map((j) => {
            const o = j.order;
            const id = o.displayId ?? o.orderNumber ?? o.id.slice(-5);
            const addr = [o.addressLine1, o.city, o.postcode].filter(Boolean).join(", ");
            const tappable = tab === "active";
            const st = STATUS[j.status] ?? { label: j.status, color: C.textDim };
            const isCash = (o.paymentMethod ?? "").toUpperCase().includes("CASH");
            return (
              <Pressable
                key={j.id}
                style={(s) => [styles.row, s.pressed && tappable && { backgroundColor: C.surface2 }]}
                disabled={!tappable}
                onPress={() => tappable && onOpenJob(j)}
              >
                <View style={[styles.rail, { backgroundColor: st.color }]} />
                <View style={{ flex: 1 }}>
                  <View style={styles.rowTop}>
                    <Text style={styles.rowId}>#{id}</Text>
                    <Text style={[styles.status, { color: st.color, borderColor: st.color }]}>{st.label}</Text>
                  </View>
                  <Text style={styles.rowName} numberOfLines={1}>
                    {o.customerName ?? "Customer"}
                  </Text>
                  {!!addr && (
                    <Text style={styles.rowAddr} numberOfLines={1}>
                      {addr}
                    </Text>
                  )}
                  <Text style={styles.rowDate}>
                    {new Date(j.assignedAt).toLocaleString([], {
                      day: "numeric",
                      month: "short",
                      hour: "2-digit",
                      minute: "2-digit",
                    })}
                  </Text>
                </View>
                <View style={{ alignItems: "flex-end", gap: 4 }}>
                  <Text style={styles.rowTotal}>{money(o.total)}</Text>
                  <Text style={[styles.method, isCash && { color: C.brand }]}>{isCash ? "CASH" : "PAID"}</Text>
                  {tappable && <Icon name="chevron-forward" size={16} color={C.textMute} />}
                </View>
              </Pressable>
            );
          })}
        </ScrollView>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: C.bg },
  center: { flex: 1, alignItems: "center", justifyContent: "center" },
  controls: { padding: 14, paddingBottom: 4, gap: 10 },
  periods: { flexDirection: "row", gap: 8 },
  period: {
    paddingHorizontal: 13,
    paddingVertical: 7,
    borderRadius: R.pill,
    borderWidth: 1,
    borderColor: C.border,
    backgroundColor: C.surface,
  },
  periodOn: { backgroundColor: C.text, borderColor: C.text },
  periodText: { color: C.textDim, fontWeight: "700", fontSize: 12 },
  periodTextOn: { color: C.bg },
  error: { color: C.danger, textAlign: "center", marginVertical: 10 },
  empty: { alignItems: "center", marginTop: 50, gap: 10 },
  emptyText: { color: C.textMute, fontWeight: "700" },
  row: {
    backgroundColor: C.surface,
    borderRadius: R.md,
    borderWidth: 1,
    borderColor: C.border,
    padding: 14,
    paddingLeft: 18,
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    overflow: "hidden",
  },
  rail: { position: "absolute", left: 0, top: 0, bottom: 0, width: 4 },
  rowTop: { flexDirection: "row", alignItems: "center", gap: 8 },
  rowId: { fontWeight: "800", color: C.textDim, fontFamily: mono, fontSize: 13 },
  status: {
    fontSize: 10,
    fontWeight: "800",
    borderWidth: 1,
    borderRadius: 6,
    paddingHorizontal: 6,
    paddingVertical: 1,
    overflow: "hidden",
    textTransform: "uppercase",
    letterSpacing: 0.4,
  },
  rowName: { color: C.text, fontWeight: "800", fontSize: 16, marginTop: 4 },
  rowAddr: { color: C.textDim, fontSize: 13, marginTop: 2 },
  rowDate: { color: C.textMute, fontSize: 11, marginTop: 4 },
  rowTotal: { fontWeight: "900", color: C.text, fontSize: 16, fontVariant: ["tabular-nums"] },
  method: { fontSize: 10, color: C.textMute, fontWeight: "800", letterSpacing: 0.6 },
});
