import { useCallback, useEffect, useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { Job, getMyDay } from "@/services/auth";
import type { OrdersTab } from "@/components/Drawer";

const PERIODS = [
  { key: "all", label: "All", days: 0 },
  { key: "today", label: "Today", days: 1 },
  { key: "7", label: "7 days", days: 7 },
  { key: "30", label: "30 days", days: 30 },
] as const;

export function OrdersScreen({
  initialTab,
  onBack,
  onOpenJob,
}: {
  initialTab: OrdersTab;
  onBack: () => void;
  onOpenJob: (job: Job) => void;
}) {
  const [tab, setTab] = useState<OrdersTab>(initialTab);
  const [period, setPeriod] = useState<(typeof PERIODS)[number]["key"]>("all");
  const [active, setActive] = useState<Job[]>([]);
  const [history, setHistory] = useState<Job[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      const d = await getMyDay();
      setActive(d.active);
      setHistory(d.history);
    } catch {
      /* ignore */
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  function withinPeriod(j: Job): boolean {
    if (period === "all") return true;
    const days = PERIODS.find((p) => p.key === period)?.days ?? 0;
    if (!days) return true;
    const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
    return new Date(j.assignedAt).getTime() >= cutoff;
  }

  let list: Job[] = [];
  if (tab === "active") list = active;
  else if (tab === "delivered") list = history.filter((j) => j.status === "DELIVERED");
  else list = [...active, ...history];
  list = list.filter(withinPeriod);

  return (
    <View style={styles.container}>
      <View style={styles.topbar}>
        <Pressable onPress={onBack} hitSlop={10}>
          <Text style={styles.back}>‹ Back</Text>
        </Pressable>
        <Text style={styles.title}>Orders</Text>
        <View style={{ width: 50 }} />
      </View>

      <View style={styles.tabs}>
        {(["active", "delivered", "history"] as OrdersTab[]).map((t) => (
          <Pressable key={t} onPress={() => setTab(t)} style={[styles.tab, tab === t && styles.tabActive]}>
            <Text style={[styles.tabText, tab === t && styles.tabTextActive]}>
              {t === "active" ? "Active" : t === "delivered" ? "Delivered" : "History"}
            </Text>
          </Pressable>
        ))}
      </View>

      {tab === "history" && (
        <View style={styles.periods}>
          {PERIODS.map((p) => (
            <Pressable key={p.key} onPress={() => setPeriod(p.key)} style={[styles.period, period === p.key && styles.periodActive]}>
              <Text style={[styles.periodText, period === p.key && styles.periodTextActive]}>{p.label}</Text>
            </Pressable>
          ))}
        </View>
      )}

      {loading ? (
        <View style={styles.center}>
          <ActivityIndicator />
        </View>
      ) : (
        <ScrollView
          style={{ flex: 1 }}
          contentContainerStyle={{ padding: 12 }}
          refreshControl={<RefreshControl refreshing={false} onRefresh={load} />}
        >
          {list.length === 0 && <Text style={styles.empty}>No orders here.</Text>}
          {list.map((j) => {
            const o = j.order;
            const id = o.displayId ?? o.orderNumber ?? o.id.slice(-5);
            const addr = [o.addressLine1, o.city, o.postcode].filter(Boolean).join(", ");
            const tappable = tab === "active";
            return (
              <Pressable
                key={j.id}
                style={styles.row}
                disabled={!tappable}
                onPress={() => tappable && onOpenJob(j)}
              >
                <View style={{ flex: 1 }}>
                  <Text style={styles.rowId}>
                    #{id} · {o.customerName ?? "Customer"}
                  </Text>
                  {!!addr && (
                    <Text style={styles.rowAddr} numberOfLines={1}>
                      {addr}
                    </Text>
                  )}
                  <Text style={styles.rowDate}>{new Date(j.assignedAt).toLocaleString()}</Text>
                </View>
                <View style={{ alignItems: "flex-end" }}>
                  <Text style={styles.rowTotal}>£{o.total}</Text>
                  <Text style={styles.rowStatus}>{j.status}</Text>
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
  container: { flex: 1, backgroundColor: "#f1f5f9" },
  center: { flex: 1, alignItems: "center", justifyContent: "center" },
  topbar: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 12,
    paddingVertical: 12,
    backgroundColor: "#0F172A",
  },
  back: { color: "#fff", fontSize: 16, width: 50 },
  title: { color: "#fff", fontSize: 16, fontWeight: "800" },
  tabs: { flexDirection: "row", backgroundColor: "#0F172A", paddingHorizontal: 12, paddingBottom: 10, gap: 8 },
  tab: { flex: 1, paddingVertical: 8, borderRadius: 8, alignItems: "center", backgroundColor: "#1e293b" },
  tabActive: { backgroundColor: "#f97316" },
  tabText: { color: "#cbd5e1", fontWeight: "700", fontSize: 13 },
  tabTextActive: { color: "#fff" },
  periods: { flexDirection: "row", gap: 8, padding: 12, paddingBottom: 0 },
  period: { paddingHorizontal: 12, paddingVertical: 6, borderRadius: 999, borderWidth: 1, borderColor: "#cbd5e1" },
  periodActive: { backgroundColor: "#0F172A", borderColor: "#0F172A" },
  periodText: { color: "#334155", fontWeight: "600", fontSize: 12 },
  periodTextActive: { color: "#fff" },
  empty: { color: "#64748b", textAlign: "center", marginTop: 30 },
  row: {
    backgroundColor: "#fff",
    borderRadius: 12,
    padding: 14,
    marginBottom: 8,
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
  },
  rowId: { fontWeight: "800", color: "#0F172A" },
  rowAddr: { color: "#64748b", fontSize: 12, marginTop: 2 },
  rowDate: { color: "#94a3b8", fontSize: 11, marginTop: 2 },
  rowTotal: { fontWeight: "800", color: "#0F172A" },
  rowStatus: { fontSize: 10, color: "#f97316", fontWeight: "700", marginTop: 2 },
});
