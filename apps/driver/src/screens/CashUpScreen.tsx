import { useCallback, useEffect, useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { CashUp, getCashUp } from "@/services/auth";

type PeriodKey = "today" | "7" | "30" | "month";

function rangeFor(key: PeriodKey): { from: string; to: string } {
  const to = new Date();
  const from = new Date();
  if (key === "today") from.setHours(0, 0, 0, 0);
  else if (key === "7") from.setDate(from.getDate() - 7);
  else if (key === "30") from.setDate(from.getDate() - 30);
  else if (key === "month") {
    from.setDate(1);
    from.setHours(0, 0, 0, 0);
  }
  return { from: from.toISOString(), to: to.toISOString() };
}

const PERIODS: { key: PeriodKey; label: string }[] = [
  { key: "today", label: "Today" },
  { key: "7", label: "7 days" },
  { key: "30", label: "30 days" },
  { key: "month", label: "This month" },
];

export function CashUpScreen({ onBack }: { onBack: () => void }) {
  const [period, setPeriod] = useState<PeriodKey>("today");
  const [data, setData] = useState<CashUp | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async (key: PeriodKey) => {
    setLoading(true);
    try {
      const { from, to } = rangeFor(key);
      setData(await getCashUp(from, to));
    } catch {
      /* ignore */
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load(period);
  }, [period, load]);

  return (
    <View style={styles.container}>
      <View style={styles.topbar}>
        <Pressable onPress={onBack} hitSlop={10}>
          <Text style={styles.back}>‹ Back</Text>
        </Pressable>
        <Text style={styles.title}>Cash up</Text>
        <View style={{ width: 50 }} />
      </View>

      <View style={styles.periods}>
        {PERIODS.map((p) => (
          <Pressable key={p.key} onPress={() => setPeriod(p.key)} style={[styles.period, period === p.key && styles.periodActive]}>
            <Text style={[styles.periodText, period === p.key && styles.periodTextActive]}>{p.label}</Text>
          </Pressable>
        ))}
      </View>

      <ScrollView contentContainerStyle={{ padding: 16 }}>
        {loading ? (
          <ActivityIndicator style={{ marginTop: 40 }} />
        ) : (
          <>
            <View style={styles.earnCard}>
              <Text style={styles.earnLabel}>Your earnings</Text>
              <Text style={styles.earnValue}>£{data?.earning ?? "0.00"}</Text>
              <Text style={styles.earnBreakdown}>
                £{data?.startupFee ?? "0.00"} start-up + £{data?.deliveryFees ?? "0.00"} delivery
              </Text>
            </View>

            <View style={styles.totalCard}>
              <Text style={styles.totalValue}>£{data?.total ?? "0.00"}</Text>
              <Text style={styles.totalLabel}>collected · {data?.deliveries ?? 0} deliveries</Text>
            </View>

            <View style={styles.row}>
              <Stat label="Cash orders" value={`${data?.cashCount ?? 0}`} />
              <Stat label="Cash total" value={`£${data?.cashTotal ?? "0.00"}`} accent="#16a34a" />
            </View>
            <View style={styles.row}>
              <Stat label="Card orders" value={`${data?.cardCount ?? 0}`} />
              <Stat label="Card total" value={`£${data?.cardTotal ?? "0.00"}`} accent="#2563eb" />
            </View>
          </>
        )}
      </ScrollView>
    </View>
  );
}

function Stat({ label, value, accent }: { label: string; value: string; accent?: string }) {
  return (
    <View style={styles.stat}>
      <Text style={[styles.statValue, accent ? { color: accent } : null]}>{value}</Text>
      <Text style={styles.statLabel}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#f1f5f9" },
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
  periods: { flexDirection: "row", gap: 8, padding: 12, backgroundColor: "#0F172A", flexWrap: "wrap" },
  period: { paddingHorizontal: 12, paddingVertical: 6, borderRadius: 999, backgroundColor: "#1e293b" },
  periodActive: { backgroundColor: "#f97316" },
  periodText: { color: "#cbd5e1", fontWeight: "600", fontSize: 12 },
  periodTextActive: { color: "#fff" },
  earnCard: { backgroundColor: "#f97316", borderRadius: 16, padding: 22, alignItems: "center", marginBottom: 14 },
  earnLabel: { color: "#fff", fontWeight: "700", opacity: 0.9 },
  earnValue: { color: "#fff", fontSize: 42, fontWeight: "900", marginTop: 2 },
  earnBreakdown: { color: "#fff", opacity: 0.9, marginTop: 4, fontSize: 12 },
  totalCard: { backgroundColor: "#0F172A", borderRadius: 16, padding: 22, alignItems: "center", marginBottom: 14 },
  totalValue: { color: "#fff", fontSize: 38, fontWeight: "900" },
  totalLabel: { color: "#cbd5e1", marginTop: 4 },
  row: { flexDirection: "row", gap: 12, marginBottom: 12 },
  stat: { flex: 1, backgroundColor: "#fff", borderRadius: 12, padding: 16 },
  statValue: { fontSize: 22, fontWeight: "800", color: "#0F172A" },
  statLabel: { color: "#64748b", fontSize: 12, marginTop: 4 },
});
