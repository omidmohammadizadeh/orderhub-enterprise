import { useEffect, useRef } from "react";
import {
  Animated,
  Dimensions,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { DriverProfile, Job, MyDay } from "@/services/auth";

const PANEL_W = Math.min(330, Dimensions.get("window").width * 0.85);

// Hamburger side panel: account, cash-up, today's orders, history, profile, logout.
export function Drawer({
  open,
  onClose,
  me,
  day,
  onSignOut,
  onOpenProfile,
  onOpenJob,
}: {
  open: boolean;
  onClose: () => void;
  me: DriverProfile | null;
  day: MyDay | null;
  onSignOut: () => void;
  onOpenProfile: () => void;
  onOpenJob: (job: Job) => void;
}) {
  const x = useRef(new Animated.Value(-PANEL_W)).current;

  useEffect(() => {
    Animated.timing(x, {
      toValue: open ? 0 : -PANEL_W,
      duration: 220,
      useNativeDriver: true,
    }).start();
  }, [open, x]);

  const cash = day?.cashUp;
  const today = day?.active ?? [];
  const history = day?.history ?? [];

  return (
    <View style={StyleSheet.absoluteFill} pointerEvents={open ? "auto" : "none"}>
      {open && <Pressable style={styles.backdrop} onPress={onClose} />}
      <Animated.View style={[styles.panel, { transform: [{ translateX: x }] }]}>
        <View style={styles.header}>
          <Text style={styles.name}>
            {me ? `${me.firstName} ${me.lastName}` : "Driver"}
          </Text>
          <Text
            style={[
              styles.status,
              { color: me?.presence?.status === "OFFLINE" || !me?.presence ? "#94a3b8" : "#16a34a" },
            ]}
          >
            {me?.presence?.status === "ON_JOB"
              ? "On a job"
              : me?.presence?.status === "ONLINE"
                ? "Online"
                : "Offline"}
          </Text>
        </View>

        <ScrollView style={{ flex: 1 }} showsVerticalScrollIndicator={false}>
          <Text style={styles.section}>My deliveries (today)</Text>
          <View style={styles.cashGrid}>
            <Cash label="Deliveries" value={`${cash?.deliveries ?? 0}`} />
            <Cash label="Cash" value={`£${cash?.cashTotal ?? "0.00"}`} />
            <Cash label="Card" value={`£${cash?.cardTotal ?? "0.00"}`} />
            <Cash label="Total" value={`£${cash?.total ?? "0.00"}`} big />
          </View>

          <Text style={styles.section}>Today&apos;s orders</Text>
          {today.length === 0 && <Text style={styles.empty}>No active deliveries.</Text>}
          {today.map((j) => (
            <JobRow key={j.id} job={j} onPress={() => onOpenJob(j)} />
          ))}

          <Text style={styles.section}>History</Text>
          {history.length === 0 && <Text style={styles.empty}>No past deliveries yet.</Text>}
          {history.slice(0, 30).map((j) => (
            <JobRow key={j.id} job={j} muted />
          ))}

          <View style={{ height: 16 }} />
        </ScrollView>

        <Pressable style={styles.profileBtn} onPress={onOpenProfile}>
          <Text style={styles.profileText}>Profile &amp; account</Text>
        </Pressable>
        <Pressable style={styles.logout} onPress={onSignOut}>
          <Text style={styles.logoutText}>Log out</Text>
        </Pressable>
      </Animated.View>
    </View>
  );
}

function JobRow({ job, onPress, muted }: { job: Job; onPress?: () => void; muted?: boolean }) {
  const o = job.order;
  const id = o.displayId ?? o.orderNumber ?? o.id.slice(-5);
  const addr = [o.addressLine1, o.city].filter(Boolean).join(", ");
  return (
    <Pressable style={styles.jobRow} onPress={onPress} disabled={!onPress}>
      <Text style={[styles.jobId, muted && { color: "#64748b" }]}>#{id}</Text>
      <View style={{ flex: 1 }}>
        <Text style={[styles.jobName, muted && { color: "#94a3b8" }]} numberOfLines={1}>
          {o.customerName ?? "Customer"}
        </Text>
        {!!addr && (
          <Text style={styles.jobAddr} numberOfLines={1}>
            {addr}
          </Text>
        )}
      </View>
      <Text style={styles.jobStatus}>{job.status}</Text>
    </Pressable>
  );
}

function Cash({ label, value, big }: { label: string; value: string; big?: boolean }) {
  return (
    <View style={[styles.cashCell, big && styles.cashCellBig]}>
      <Text style={[styles.cashValue, big && { fontSize: 22 }]}>{value}</Text>
      <Text style={styles.cashLabel}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  backdrop: { ...StyleSheet.absoluteFillObject, backgroundColor: "rgba(0,0,0,0.4)" },
  panel: {
    position: "absolute",
    left: 0,
    top: 0,
    bottom: 0,
    width: PANEL_W,
    backgroundColor: "#0F172A",
    paddingTop: 64,
    paddingHorizontal: 20,
    paddingBottom: 28,
  },
  header: { borderBottomWidth: 1, borderBottomColor: "#1e293b", paddingBottom: 16 },
  name: { color: "#fff", fontSize: 20, fontWeight: "800" },
  status: { fontSize: 13, fontWeight: "700", marginTop: 4 },
  section: {
    color: "#94a3b8",
    fontSize: 12,
    fontWeight: "700",
    textTransform: "uppercase",
    marginTop: 22,
    marginBottom: 10,
  },
  empty: { color: "#64748b", fontSize: 13 },
  cashGrid: { flexDirection: "row", flexWrap: "wrap", gap: 10 },
  cashCell: { backgroundColor: "#1e293b", borderRadius: 12, padding: 14, width: "47%" },
  cashCellBig: { width: "100%", backgroundColor: "#f97316" },
  cashValue: { color: "#fff", fontSize: 18, fontWeight: "800" },
  cashLabel: { color: "#cbd5e1", fontSize: 12, marginTop: 4 },
  jobRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingVertical: 9,
    borderBottomWidth: 1,
    borderBottomColor: "#1e293b",
  },
  jobId: { color: "#fff", fontWeight: "800", width: 56, fontSize: 13 },
  jobName: { color: "#e2e8f0", fontWeight: "600", fontSize: 13 },
  jobAddr: { color: "#64748b", fontSize: 11, marginTop: 1 },
  jobStatus: { color: "#94a3b8", fontSize: 10, fontWeight: "700" },
  profileBtn: {
    backgroundColor: "#1e293b",
    borderRadius: 12,
    paddingVertical: 13,
    alignItems: "center",
    marginBottom: 10,
  },
  profileText: { color: "#fff", fontWeight: "700", fontSize: 15 },
  logout: { backgroundColor: "#1e293b", borderRadius: 12, paddingVertical: 14, alignItems: "center" },
  logoutText: { color: "#f87171", fontWeight: "800", fontSize: 15 },
});
