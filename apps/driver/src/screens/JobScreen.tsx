import { useCallback, useEffect, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Linking,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { Job, JobActionType, getMyDay, jobAction } from "@/services/auth";
import { SlideToConfirm } from "@/components/SlideToConfirm";

// Deadline colours match the dispatch console house pins: green → orange (≤15m)
// → red (≤5m / overdue).
function deadline(deadlineAt: string | null): { text: string; color: string } | null {
  if (!deadlineAt) return null;
  const ms = new Date(deadlineAt).getTime() - Date.now();
  const mins = Math.round(ms / 60_000);
  if (mins < 0) return { text: `${Math.abs(mins)} min late`, color: "#dc2626" };
  const color = mins <= 5 ? "#dc2626" : mins <= 15 ? "#f97316" : "#16a34a";
  return { text: `Due in ${mins} min`, color };
}

export function JobScreen({
  job: initialJob,
  onBack,
  onChanged,
}: {
  job: Job;
  onBack: () => void;
  onChanged: () => void;
}) {
  const [job, setJob] = useState<Job>(initialJob);
  const [total, setTotal] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [, tick] = useState(0); // re-render so the deadline pill counts down

  const o = job.order;
  const address = [o.addressLine1, o.addressLine2, o.city, o.postcode].filter(Boolean).join(", ");
  const pickedUp = job.status === "PICKED_UP";
  const arrived = !!job.arrivedAt;
  const due = deadline(o.deadlineAt);

  // Pull the latest state for this job + how many active stops there are (for the
  // "Stop 1/3" badge). Keeps the card self-sufficient after each step.
  const refresh = useCallback(async () => {
    try {
      const day = await getMyDay();
      setTotal(day.active.length);
      const fresh = day.active.find((j) => j.id === job.id) ?? day.history.find((j) => j.id === job.id);
      if (fresh) setJob(fresh);
    } catch {
      // keep showing what we have
    }
  }, [job.id]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // Count the deadline pill down once a minute.
  useEffect(() => {
    const id = setInterval(() => tick((t) => t + 1), 30_000);
    return () => clearInterval(id);
  }, []);

  function navigate() {
    let dest = "";
    if (o.deliveryLat != null && o.deliveryLng != null) dest = `${o.deliveryLat},${o.deliveryLng}`;
    else if (address) dest = encodeURIComponent(address);
    if (!dest) {
      Alert.alert("No address", "This order has no address to navigate to.");
      return;
    }
    Linking.openURL(`https://www.google.com/maps/dir/?api=1&destination=${dest}`);
  }

  // Marketplace orders (Just Eat / Uber Eats / Deliveroo) mask the customer's
  // number behind courierPhone, and some need the access code dialled after a
  // pause (",," ≈ 2s) to connect. Direct/POS orders dial the customer directly.
  function call() {
    if (o.courierPhone) {
      const tel = o.courierPhoneAccessCode
        ? `tel:${o.courierPhone},,${o.courierPhoneAccessCode}`
        : `tel:${o.courierPhone}`;
      Linking.openURL(tel);
      return;
    }
    if (o.customerPhone) {
      Linking.openURL(`tel:${o.customerPhone}`);
      return;
    }
    Alert.alert("No phone", "No phone number on this order.");
  }

  // start / arrived advance the job in place; delivered / skip / cancel finish
  // it and return to the list.
  async function act(action: JobActionType) {
    setBusy(true);
    try {
      await jobAction(o.id, action);
      if (action === "start" || action === "arrived") {
        // Advance in place — refresh this card so the next slider appears. (Don't
        // call onChanged here: it remounts the card from the stale prop and the
        // previous slider flashes back before the refresh lands.)
        await refresh();
      } else {
        onChanged();
        onBack();
      }
    } catch (err) {
      Alert.alert("Error", (err as Error)?.message ?? "Try again");
    } finally {
      setBusy(false);
    }
  }

  function confirmSkip() {
    Alert.alert("Skip this delivery?", "Use when the customer didn't answer.", [
      { text: "Cancel", style: "cancel" },
      { text: "Skip", style: "destructive", onPress: () => act("skip") },
    ]);
  }
  function confirmCancel() {
    Alert.alert("Cancel this job?", "Returns the order to dispatch (use for incidents).", [
      { text: "Back", style: "cancel" },
      { text: "Cancel job", style: "destructive", onPress: () => act("cancel") },
    ]);
  }

  return (
    <View style={styles.container}>
      <View style={styles.topbar}>
        <Pressable onPress={onBack} hitSlop={10}>
          <Text style={styles.back}>‹ Back</Text>
        </Pressable>
        <Text style={styles.title}>#{o.displayId ?? o.orderNumber ?? o.id.slice(-5)}</Text>
        <View style={{ width: 50 }} />
      </View>

      <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 16 }}>
        <View style={styles.headerRow}>
          {job.sequence != null && (
            <View style={styles.stopBadge}>
              <Text style={styles.stopText}>
                Stop {job.sequence}
                {total ? `/${total}` : ""}
              </Text>
            </View>
          )}
          {due && (
            <View style={[styles.duePill, { backgroundColor: due.color }]}>
              <Text style={styles.dueText}>{due.text}</Text>
            </View>
          )}
        </View>

        <Text style={styles.name}>{o.customerName ?? "Customer"}</Text>
        <Text style={styles.addr}>{address || "No address"}</Text>
        {!!o.specialInstructions && <Text style={styles.note}>“{o.specialInstructions}”</Text>}

        <View style={styles.metaRow}>
          <Meta label="Total" value={`£${o.total}`} />
          <Meta label="Payment" value={(o.paymentMethod ?? "—").toUpperCase()} />
          <Meta label="Status" value={arrived && pickedUp ? "ARRIVED" : job.status} />
        </View>

        <View style={styles.actions}>
          <Pressable style={[styles.action, { backgroundColor: "#2563eb" }]} onPress={navigate}>
            <Text style={styles.actionText}>Navigate</Text>
          </Pressable>
          <Pressable style={[styles.action, { backgroundColor: "#16a34a" }]} onPress={call}>
            <Text style={styles.actionText}>Call</Text>
          </Pressable>
        </View>
      </ScrollView>

      <View style={styles.footer}>
        {busy ? (
          <View style={styles.busy}>
            <ActivityIndicator color="#0F172A" />
          </View>
        ) : !pickedUp ? (
          <SlideToConfirm label="Slide to start" color="#16a34a" onConfirm={() => act("start")} />
        ) : !arrived ? (
          <SlideToConfirm label="Slide to arrived" color="#f97316" onConfirm={() => act("arrived")} />
        ) : (
          <SlideToConfirm
            label="Slide to delivered ✓"
            color="#475569"
            onConfirm={() => act("delivered")}
          />
        )}
        <View style={styles.footRow}>
          <Pressable onPress={confirmSkip}>
            <Text style={styles.skip}>Skip (no answer)</Text>
          </Pressable>
          <Pressable onPress={confirmCancel}>
            <Text style={styles.cancel}>Cancel job</Text>
          </Pressable>
        </View>
      </View>
    </View>
  );
}

function Meta({ label, value }: { label: string; value: string }) {
  return (
    <View style={{ flex: 1 }}>
      <Text style={styles.metaLabel}>{label}</Text>
      <Text style={styles.metaValue}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#fff" },
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
  headerRow: { flexDirection: "row", alignItems: "center", gap: 10, marginBottom: 14 },
  stopBadge: { backgroundColor: "#0F172A", borderRadius: 8, paddingHorizontal: 10, paddingVertical: 5 },
  stopText: { color: "#fff", fontWeight: "800", fontSize: 13 },
  duePill: { borderRadius: 8, paddingHorizontal: 10, paddingVertical: 5 },
  dueText: { color: "#fff", fontWeight: "800", fontSize: 13 },
  name: { fontSize: 22, fontWeight: "800", color: "#0F172A" },
  addr: { fontSize: 15, color: "#334155", marginTop: 4 },
  note: { fontStyle: "italic", color: "#b45309", marginTop: 8 },
  metaRow: { flexDirection: "row", marginTop: 20, gap: 8 },
  metaLabel: { fontSize: 11, color: "#64748b" },
  metaValue: { fontSize: 15, fontWeight: "800", color: "#0F172A", marginTop: 2 },
  actions: { flexDirection: "row", gap: 10, marginTop: 22 },
  action: { flex: 1, borderRadius: 10, paddingVertical: 14, alignItems: "center" },
  actionText: { color: "#fff", fontWeight: "800", fontSize: 15 },
  footer: { padding: 16, borderTopWidth: 1, borderTopColor: "#e2e8f0", gap: 12 },
  busy: { height: 60, alignItems: "center", justifyContent: "center" },
  footRow: { flexDirection: "row", justifyContent: "space-between", paddingHorizontal: 6 },
  skip: { color: "#b45309", fontWeight: "700" },
  cancel: { color: "#dc2626", fontWeight: "700" },
});
