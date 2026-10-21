import { useCallback, useEffect, useState } from "react";
import { ActivityIndicator, ScrollView, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { CashUp, getCashUp } from "@/services/auth";
import { Header, Icon, IconName, Segmented } from "@/components/ui";
import { C, R, money } from "@/theme";

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
  { key: "month", label: "Month" },
];

export function CashUpScreen({ onBack }: { onBack: () => void }) {
  const insets = useSafeAreaInsets();
  const [period, setPeriod] = useState<PeriodKey>("today");
  const [data, setData] = useState<CashUp | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  const load = useCallback(async (key: PeriodKey) => {
    setLoading(true);
    try {
      const { from, to } = rangeFor(key);
      setData(await getCashUp(from, to));
      setError(false);
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load(period);
  }, [period, load]);

  // What the driver hands back: cash in pocket minus what they earned. Negative
  // means the shop owes the driver — same rule as the operator's cash-up.
  const handover = Number(data?.cashTotal ?? 0) - Number(data?.earning ?? 0);

  return (
    <View style={styles.container}>
      <Header title="Cash up" subtitle="Earnings and takings" onBack={onBack} />
      <View style={{ padding: 14, paddingBottom: 0 }}>
        <Segmented options={PERIODS} value={period} onChange={setPeriod} />
      </View>

      <ScrollView contentContainerStyle={{ padding: 14, paddingBottom: Math.max(insets.bottom, 14) + 8, gap: 12 }}>
        {loading ? (
          <ActivityIndicator style={{ marginTop: 40 }} color={C.textDim} />
        ) : error ? (
          <Text style={styles.error}>Couldn&apos;t load your cash-up. Check your signal and try again.</Text>
        ) : (
          <>
            <View style={styles.hero}>
              <Text style={styles.heroLabel}>YOUR EARNINGS</Text>
              <Text style={styles.heroValue}>{money(data?.earning)}</Text>
              <View style={styles.heroSplit}>
                <Text style={styles.heroPart}>
                  <Text style={styles.heroPartValue}>{money(data?.startupFee)}</Text> start-up
                </Text>
                <Text style={styles.heroPlus}>+</Text>
                <Text style={styles.heroPart}>
                  <Text style={styles.heroPartValue}>{money(data?.deliveryFees)}</Text> delivery fees
                </Text>
              </View>
            </View>

            <View style={styles.grid}>
              <Tile icon="cube-outline" label="Deliveries" value={String(data?.deliveries ?? 0)} />
              <Tile icon="receipt-outline" label="Collected" value={money(data?.total)} />
            </View>
            <View style={styles.grid}>
              <Tile icon="cash-outline" label={`Cash · ${plural(data?.cashCount ?? 0, "order")}`} value={money(data?.cashTotal)} accent={C.brand} />
              <Tile icon="card-outline" label={`Card · ${plural(data?.cardCount ?? 0, "order")}`} value={money(data?.cardTotal)} accent={C.info} />
            </View>

            <View style={styles.handover}>
              <View style={{ flex: 1 }}>
                <Text style={styles.handoverLabel}>{handover >= 0 ? "Cash to hand in" : "Shop owes you"}</Text>
                <Text style={styles.handoverSub}>Cash collected minus your earnings</Text>
              </View>
              <Text style={[styles.handoverValue, { color: handover >= 0 ? C.text : C.go }]}>
                {money(Math.abs(handover))}
              </Text>
            </View>
          </>
        )}
      </ScrollView>
    </View>
  );
}

function Tile({ icon, label, value, accent }: { icon: IconName; label: string; value: string; accent?: string }) {
  return (
    <View style={styles.tile}>
      <Icon name={icon} size={18} color={accent ?? C.textDim} />
      <Text style={[styles.tileValue, accent ? { color: accent } : null]} numberOfLines={1} adjustsFontSizeToFit>
        {value}
      </Text>
      <Text style={styles.tileLabel}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: C.bg },
  error: { color: C.danger, textAlign: "center", marginTop: 30 },
  hero: {
    backgroundColor: C.surface,
    borderRadius: R.xl,
    borderWidth: 1,
    borderColor: "rgba(30,214,127,0.35)",
    padding: 22,
    alignItems: "center",
  },
  heroLabel: { color: C.textMute, fontWeight: "800", fontSize: 11, letterSpacing: 1.4 },
  heroValue: { color: C.go, fontSize: 48, fontWeight: "900", marginTop: 4, fontVariant: ["tabular-nums"] },
  heroSplit: { flexDirection: "row", alignItems: "center", gap: 8, marginTop: 8 },
  heroPart: { color: C.textDim, fontSize: 13 },
  heroPartValue: { color: C.text, fontWeight: "800" },
  heroPlus: { color: C.textMute, fontWeight: "800" },
  grid: { flexDirection: "row", gap: 12 },
  tile: {
    flex: 1,
    backgroundColor: C.surface,
    borderRadius: R.lg,
    borderWidth: 1,
    borderColor: C.border,
    padding: 16,
    gap: 6,
  },
  tileValue: { fontSize: 24, fontWeight: "900", color: C.text, fontVariant: ["tabular-nums"] },
  tileLabel: { color: C.textMute, fontSize: 12, fontWeight: "700" },
  handover: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: C.surface2,
    borderRadius: R.lg,
    borderWidth: 1,
    borderColor: C.borderStrong,
    padding: 16,
  },
  handoverLabel: { color: C.text, fontWeight: "800", fontSize: 15 },
  handoverSub: { color: C.textMute, fontSize: 12, marginTop: 2 },
  handoverValue: { fontSize: 24, fontWeight: "900", fontVariant: ["tabular-nums"] },
});

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}
