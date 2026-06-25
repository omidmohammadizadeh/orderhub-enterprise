import { useState } from "react";
import {
  Alert,
  Linking,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { Job, jobAction } from "@/services/auth";
import { SlideToConfirm } from "@/components/SlideToConfirm";

export function JobScreen({
  job,
  onBack,
  onChanged,
}: {
  job: Job;
  onBack: () => void;
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const o = job.order;
  const address = [o.addressLine1, o.addressLine2, o.city, o.postcode].filter(Boolean).join(", ");
  const pickedUp = job.status === "PICKED_UP";

  function navigate() {
    let dest = "";
    if (o.deliveryLat != null && o.deliveryLng != null) dest = `${o.deliveryLat},${o.deliveryLng}`;
    else if (address) dest = encodeURIComponent(address);
    if (!dest) {
      Alert.alert("No address", "This order has no address to navigate to.");
      return;
    }
    const url = `https://www.google.com/maps/dir/?api=1&destination=${dest}`;
    Linking.openURL(url);
  }

  function call() {
    if (!o.customerPhone) {
      Alert.alert("No phone", "No customer phone number on this order.");
      return;
    }
    Linking.openURL(`tel:${o.customerPhone}`);
  }

  async function act(action: "start" | "delivered" | "skip" | "cancel") {
    setBusy(true);
    try {
      await jobAction(o.id, action);
      onChanged();
      onBack();
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
        <Text style={styles.title}>
          #{o.displayId ?? o.orderNumber ?? o.id.slice(-5)}
        </Text>
        <View style={{ width: 50 }} />
      </View>

      <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 16 }}>
        <Text style={styles.name}>{o.customerName ?? "Customer"}</Text>
        <Text style={styles.addr}>{address || "No address"}</Text>
        {!!o.specialInstructions && <Text style={styles.note}>“{o.specialInstructions}”</Text>}

        <View style={styles.metaRow}>
          <Meta label="Total" value={`£${o.total}`} />
          <Meta label="Payment" value={(o.paymentMethod ?? "—").toUpperCase()} />
          <Meta label="Status" value={job.status} />
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
        {pickedUp ? (
          <SlideToConfirm
            label="Slide to delivered"
            color="#f97316"
            onConfirm={() => !busy && act("delivered")}
          />
        ) : (
          <SlideToConfirm
            label="Slide to start"
            color="#16a34a"
            onConfirm={() => !busy && act("start")}
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
  footRow: { flexDirection: "row", justifyContent: "space-between", paddingHorizontal: 6 },
  skip: { color: "#b45309", fontWeight: "700" },
  cancel: { color: "#dc2626", fontWeight: "700" },
});
