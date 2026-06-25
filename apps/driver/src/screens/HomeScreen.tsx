import { useCallback, useEffect, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  View,
} from "react-native";
import {
  DriverProfile,
  Job,
  LocationSummary,
  MyDay,
  getLocations,
  getMe,
  getMyDay,
  goOffline,
  goOnline,
} from "@/services/auth";
import { pingNow, startLocationUpdates, stopLocationUpdates } from "@/services/location";

export function HomeScreen({
  onOpenJob,
  onSignOut,
}: {
  onOpenJob: (job: Job) => void;
  onSignOut: () => void;
}) {
  const [me, setMe] = useState<DriverProfile | null>(null);
  const [day, setDay] = useState<MyDay | null>(null);
  const [locations, setLocations] = useState<LocationSummary[]>([]);
  const [locationId, setLocationId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);

  const online = me?.presence?.status === "ONLINE" || me?.presence?.status === "ON_JOB";

  const refresh = useCallback(async () => {
    try {
      const [m, d] = await Promise.all([getMe(), getMyDay()]);
      setMe(m);
      setDay(d);
      if (m.presence?.locationId) setLocationId(m.presence.locationId);
    } catch {
      // ignore transient errors
    }
  }, []);

  useEffect(() => {
    (async () => {
      try {
        const locs = await getLocations();
        setLocations(locs);
        if (locs.length === 1) setLocationId(locs[0].id);
      } catch {
        // ignore
      }
      await refresh();
      setLoading(false);
    })();
    const t = setInterval(refresh, 10_000);
    return () => clearInterval(t);
  }, [refresh]);

  async function toggleOnline(next: boolean) {
    if (next && !locationId) {
      Alert.alert("Pick a location", "Choose which location you're delivering for first.");
      return;
    }
    setBusy(true);
    try {
      if (next) {
        await goOnline(locationId!);
        await startLocationUpdates();
        await pingNow();
      } else {
        await goOffline();
        await stopLocationUpdates();
      }
      await refresh();
    } catch (err) {
      Alert.alert("Error", (err as Error)?.message ?? "Try again");
    } finally {
      setBusy(false);
    }
  }

  if (loading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator />
      </View>
    );
  }

  const active = day?.active ?? [];
  const history = day?.history ?? [];

  return (
    <ScrollView
      style={styles.container}
      refreshControl={<RefreshControl refreshing={false} onRefresh={refresh} />}
    >
      {/* Header */}
      <View style={styles.header}>
        <View>
          <Text style={styles.hello}>
            {me?.firstName} {me?.lastName}
          </Text>
          <Text style={[styles.status, { color: online ? "#16a34a" : "#64748b" }]}>
            {me?.presence?.status === "ON_JOB" ? "On a job" : online ? "Online" : "Offline"}
          </Text>
        </View>
        <View style={{ alignItems: "flex-end" }}>
          {busy ? <ActivityIndicator /> : <Switch value={online} onValueChange={toggleOnline} />}
          <Pressable onPress={onSignOut} hitSlop={8}>
            <Text style={styles.signout}>Sign out</Text>
          </Pressable>
        </View>
      </View>

      {/* Location picker (when offline + multiple) */}
      {!online && locations.length > 1 && (
        <View style={styles.card}>
          <Text style={styles.cardTitle}>Delivering for</Text>
          <View style={styles.locRow}>
            {locations.map((l) => (
              <Pressable
                key={l.id}
                onPress={() => setLocationId(l.id)}
                style={[styles.chip, locationId === l.id && styles.chipActive]}
              >
                <Text style={[styles.chipText, locationId === l.id && styles.chipTextActive]}>
                  {l.name}
                </Text>
              </Pressable>
            ))}
          </View>
        </View>
      )}

      {/* Cash-up */}
      <View style={styles.card}>
        <Text style={styles.cardTitle}>Today</Text>
        <View style={styles.cashRow}>
          <Cash label="Deliveries" value={`${day?.cashUp.deliveries ?? 0}`} />
          <Cash label="Cash" value={`£${day?.cashUp.cashTotal ?? "0.00"}`} />
          <Cash label="Card" value={`£${day?.cashUp.cardTotal ?? "0.00"}`} />
          <Cash label="Total" value={`£${day?.cashUp.total ?? "0.00"}`} />
        </View>
      </View>

      {/* Active jobs */}
      <Text style={styles.section}>Active deliveries ({active.length})</Text>
      {active.length === 0 && <Text style={styles.empty}>No active deliveries right now.</Text>}
      {active.map((job) => (
        <Pressable key={job.id} style={styles.job} onPress={() => onOpenJob(job)}>
          <View style={styles.jobLeft}>
            <Text style={styles.jobId}>#{job.order.displayId ?? job.order.orderNumber ?? job.order.id.slice(-5)}</Text>
            <Text style={styles.jobStatus}>{job.status}</Text>
          </View>
          <View style={{ flex: 1 }}>
            <Text style={styles.jobName}>{job.order.customerName ?? "Customer"}</Text>
            <Text style={styles.jobAddr} numberOfLines={1}>
              {[job.order.addressLine1, job.order.city, job.order.postcode].filter(Boolean).join(", ") || "—"}
            </Text>
          </View>
          <Text style={styles.jobTotal}>£{job.order.total}</Text>
        </Pressable>
      ))}

      {/* History */}
      <Text style={styles.section}>History</Text>
      {history.slice(0, 20).map((job) => (
        <View key={job.id} style={styles.histRow}>
          <Text style={styles.histId}>#{job.order.displayId ?? job.order.orderNumber ?? job.order.id.slice(-5)}</Text>
          <Text style={styles.histName} numberOfLines={1}>
            {job.order.customerName ?? "Customer"}
          </Text>
          <Text style={styles.histStatus}>{job.status}</Text>
        </View>
      ))}
      <View style={{ height: 40 }} />
    </ScrollView>
  );
}

function Cash({ label, value }: { label: string; value: string }) {
  return (
    <View style={{ alignItems: "center", flex: 1 }}>
      <Text style={styles.cashValue}>{value}</Text>
      <Text style={styles.cashLabel}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#f1f5f9" },
  center: { flex: 1, alignItems: "center", justifyContent: "center" },
  header: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    padding: 16,
    backgroundColor: "#0F172A",
  },
  hello: { color: "#fff", fontSize: 18, fontWeight: "800" },
  status: { fontSize: 13, fontWeight: "700", marginTop: 2 },
  signout: { color: "#94a3b8", fontSize: 12, marginTop: 6 },
  card: { backgroundColor: "#fff", margin: 12, marginBottom: 0, borderRadius: 12, padding: 14 },
  cardTitle: { fontWeight: "800", color: "#0F172A", marginBottom: 8 },
  locRow: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  chip: { borderWidth: 1, borderColor: "#cbd5e1", borderRadius: 999, paddingHorizontal: 12, paddingVertical: 6 },
  chipActive: { backgroundColor: "#0F172A", borderColor: "#0F172A" },
  chipText: { color: "#0F172A", fontWeight: "600" },
  chipTextActive: { color: "#fff" },
  cashRow: { flexDirection: "row" },
  cashValue: { fontSize: 16, fontWeight: "800", color: "#0F172A" },
  cashLabel: { fontSize: 11, color: "#64748b", marginTop: 2 },
  section: { fontWeight: "800", color: "#0F172A", marginHorizontal: 12, marginTop: 18, marginBottom: 6 },
  empty: { color: "#64748b", marginHorizontal: 12 },
  job: {
    backgroundColor: "#fff",
    marginHorizontal: 12,
    marginBottom: 8,
    borderRadius: 12,
    padding: 14,
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
  },
  jobLeft: { alignItems: "center", width: 64 },
  jobId: { fontWeight: "800", color: "#0F172A" },
  jobStatus: { fontSize: 10, color: "#f97316", fontWeight: "700", marginTop: 2 },
  jobName: { fontWeight: "700", color: "#0F172A" },
  jobAddr: { color: "#64748b", fontSize: 12, marginTop: 2 },
  jobTotal: { fontWeight: "800", color: "#0F172A" },
  histRow: { flexDirection: "row", alignItems: "center", gap: 10, marginHorizontal: 14, paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: "#e2e8f0" },
  histId: { fontWeight: "700", color: "#0F172A", width: 64 },
  histName: { flex: 1, color: "#334155" },
  histStatus: { fontSize: 11, color: "#64748b" },
});
