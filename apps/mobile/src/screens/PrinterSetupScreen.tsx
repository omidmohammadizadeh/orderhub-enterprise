// PrinterSetupScreen — Build A modal.
//
// Goal: prove the Bluetooth pipeline works end-to-end on real
// hardware before we wire the print agent (Build B). User flow:
//
//   1. Pair the printer once in Android Settings (passkey 0000 on TM-m30II)
//   2. Open Order Hub Solutions → tap the 🖨 icon in the WebView header
//   3. This screen shows paired devices
//   4. Tap a device → "Test Print" → receipt comes out
//
// If the test print succeeds we know we have a working BT path
// and can move on to integrating with /v1/print-jobs/claim.

import React, { useCallback, useEffect, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Linking,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";

import {
  ensureBtPermissions,
  isBtEnabled,
  listBondedDevices,
  sendBytesOverBt,
  type PairedBtDevice,
} from "@/print/transport/bluetooth";
import { buildTestReceipt } from "@/print/escpos/test-receipt";
import { printAgent, type AgentStatus } from "@/print/agent";

interface Props {
  visible: boolean;
  onClose: () => void;
}

export function PrinterSetupScreen({ visible, onClose }: Props) {
  const [devices, setDevices] = useState<PairedBtDevice[]>([]);
  const [loading, setLoading] = useState(false);
  const [btEnabled, setBtEnabled] = useState<boolean | null>(null);
  const [printingAddress, setPrintingAddress] = useState<string | null>(null);
  const [agentStatus, setAgentStatus] = useState<AgentStatus>(
    printAgent.getStatus(),
  );
  const [pairCode, setPairCode] = useState("");
  const [pairing, setPairing] = useState(false);

  useEffect(() => printAgent.subscribe(setAgentStatus), []);

  const onPair = async () => {
    if (!pairCode.trim()) {
      Alert.alert("Pair code required", "Type the 6-character code shown on the dashboard.");
      return;
    }
    setPairing(true);
    try {
      await printAgent.pairWithCode(pairCode);
      setPairCode("");
      Alert.alert(
        "Tablet paired",
        "Once the dashboard shows this tablet as online, bind your Bluetooth printer to it from the Agents tab.",
      );
    } catch (err: any) {
      Alert.alert("Pairing failed", err?.message ?? "Unknown error");
    } finally {
      setPairing(false);
    }
  };

  const onUnpair = async () => {
    Alert.alert("Unpair tablet?", "Print jobs will stop reaching this tablet.", [
      { text: "Cancel" },
      {
        text: "Unpair",
        style: "destructive",
        onPress: () => printAgent.unpair(),
      },
    ]);
  };
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const granted = await ensureBtPermissions();
      if (!granted) {
        setError(
          "Bluetooth permission denied. Open Settings → Apps → Order Hub Solutions → Permissions to grant 'Nearby devices'.",
        );
        return;
      }
      const enabled = await isBtEnabled();
      setBtEnabled(enabled);
      if (!enabled) {
        setError("Bluetooth is off. Turn it on in Quick Settings, then refresh.");
        return;
      }
      const list = await listBondedDevices();
      setDevices(list);
    } catch (e: any) {
      setError(e?.message ?? String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (visible) refresh();
  }, [visible, refresh]);

  const onTestPrint = useCallback(async (device: PairedBtDevice) => {
    setPrintingAddress(device.address);
    setError(null);
    try {
      const bytes = buildTestReceipt();
      await sendBytesOverBt(device.address, bytes);
      Alert.alert(
        "Print sent",
        `Test receipt sent to ${device.name}. Check the printer.`,
      );
    } catch (e: any) {
      const msg = e?.message ?? String(e);
      setError(`Print failed: ${msg}`);
      Alert.alert("Print failed", msg);
    } finally {
      setPrintingAddress(null);
    }
  }, []);

  return (
    <Modal
      visible={visible}
      animationType="slide"
      presentationStyle="formSheet"
      onRequestClose={onClose}
    >
      <View style={styles.root}>
        <View style={styles.header}>
          <Text style={styles.title}>Printer Setup</Text>
          <Pressable onPress={onClose} hitSlop={12}>
            <Text style={styles.close}>Done</Text>
          </Pressable>
        </View>

        <ScrollView contentContainerStyle={styles.body}>
          {/* Agent status — pair the tablet to the API once so it shows
              up in the dashboard's Agents tab and starts claiming jobs.
              Without this the test print works but real orders sit in
              the queue with no agent to pick them up. */}
          <View style={styles.agentCard}>
            <View style={styles.rowBetween}>
              <Text style={styles.sectionTitle}>Print agent</Text>
              <View
                style={[
                  styles.statusPill,
                  agentStatus.online
                    ? styles.statusPillOn
                    : agentStatus.paired
                    ? styles.statusPillWarn
                    : styles.statusPillOff,
                ]}
              >
                <Text style={styles.statusPillText}>
                  {agentStatus.online
                    ? "Online"
                    : agentStatus.paired
                    ? "Reconnecting…"
                    : "Not paired"}
                </Text>
              </View>
            </View>

            {agentStatus.paired ? (
              <>
                <Text style={styles.agentMeta}>
                  Agent ID: {agentStatus.agentId?.slice(0, 8)}…
                </Text>
                <Text style={styles.agentMeta}>
                  Bound printers: {agentStatus.printers.length}
                </Text>
                {agentStatus.lastError && (
                  <Text style={styles.errorInline}>{agentStatus.lastError}</Text>
                )}
                <Pressable onPress={onUnpair} style={styles.unpairBtn}>
                  <Text style={styles.unpairBtnText}>Unpair tablet</Text>
                </Pressable>
              </>
            ) : (
              <>
                <Text style={styles.helpBody}>
                  On a desktop, open dashboard → Printers → Agents → Pair new
                  device. Type the 6-character code shown there below.
                </Text>
                <TextInput
                  style={styles.pairInput}
                  value={pairCode}
                  onChangeText={(t) => setPairCode(t.toUpperCase().trim())}
                  placeholder="ABC123"
                  placeholderTextColor="#475569"
                  autoCapitalize="characters"
                  autoCorrect={false}
                  maxLength={8}
                />
                <Pressable
                  onPress={onPair}
                  disabled={pairing || pairCode.length < 4}
                  style={({ pressed }) => [
                    styles.pairBtn,
                    pressed && styles.pairBtnPressed,
                    (pairing || pairCode.length < 4) && styles.pairBtnDisabled,
                  ]}
                >
                  {pairing ? (
                    <ActivityIndicator color="#fff" />
                  ) : (
                    <Text style={styles.pairBtnText}>Pair tablet</Text>
                  )}
                </Pressable>
              </>
            )}
          </View>

          <View style={styles.divider} />
          <Text style={styles.helpHeader}>How to pair a Bluetooth printer</Text>
          <Text style={styles.helpBody}>
            1. Turn the printer on.{"\n"}
            2. Open Android Settings → Connected devices → Pair new device.
            {"\n"}
            3. Tap the printer name (e.g. TM-m30II_153628).{"\n"}
            4. Enter passkey 0000 if prompted.{"\n"}
            5. Return here and tap Refresh.
          </Text>
          <Pressable
            style={styles.linkBtn}
            onPress={() => Linking.openSettings()}
          >
            <Text style={styles.linkBtnText}>Open Android Settings</Text>
          </Pressable>

          <View style={styles.divider} />

          <View style={styles.rowBetween}>
            <Text style={styles.sectionTitle}>Paired devices</Text>
            <Pressable onPress={refresh} hitSlop={8}>
              <Text style={styles.refresh}>Refresh</Text>
            </Pressable>
          </View>

          {loading && (
            <View style={styles.loadingWrap}>
              <ActivityIndicator color="#F97316" />
              <Text style={styles.loadingText}>Scanning…</Text>
            </View>
          )}

          {error && (
            <View style={styles.errorBox}>
              <Text style={styles.errorText}>{error}</Text>
            </View>
          )}

          {!loading && devices.length === 0 && !error && (
            <Text style={styles.empty}>
              No paired Bluetooth devices yet. Follow the steps above, then
              tap Refresh.
            </Text>
          )}

          {devices.map((d) => (
            <View key={d.address} style={styles.card}>
              <View style={{ flex: 1 }}>
                <Text style={styles.cardName}>{d.name}</Text>
                <Text style={styles.cardAddr}>{d.address}</Text>
              </View>
              <Pressable
                onPress={() => onTestPrint(d)}
                disabled={printingAddress !== null}
                style={({ pressed }) => [
                  styles.testBtn,
                  pressed && styles.testBtnPressed,
                  printingAddress !== null && styles.testBtnDisabled,
                ]}
              >
                {printingAddress === d.address ? (
                  <ActivityIndicator color="#fff" />
                ) : (
                  <Text style={styles.testBtnText}>Test Print</Text>
                )}
              </Pressable>
            </View>
          ))}

          <View style={styles.divider} />
          <Text style={styles.foot}>
            Once test print works, the next update will auto-print incoming
            orders without opening this screen.
          </Text>
        </ScrollView>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: "#0F172A" },
  header: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingHorizontal: 16,
    paddingTop: 16,
    paddingBottom: 12,
    borderBottomWidth: 1,
    borderBottomColor: "#1E293B",
  },
  title: { color: "#fff", fontSize: 18, fontWeight: "700" },
  close: { color: "#F97316", fontSize: 16, fontWeight: "600" },
  body: { padding: 16, paddingBottom: 64 },
  helpHeader: {
    color: "#94A3B8",
    fontSize: 12,
    fontWeight: "700",
    textTransform: "uppercase",
    letterSpacing: 0.5,
    marginBottom: 8,
  },
  helpBody: { color: "#CBD5E1", fontSize: 14, lineHeight: 22 },
  linkBtn: {
    marginTop: 12,
    paddingVertical: 10,
    paddingHorizontal: 14,
    backgroundColor: "#1E293B",
    borderRadius: 8,
    alignSelf: "flex-start",
  },
  linkBtnText: { color: "#F97316", fontSize: 14, fontWeight: "600" },
  divider: { height: 1, backgroundColor: "#1E293B", marginVertical: 20 },
  rowBetween: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 12,
  },
  sectionTitle: { color: "#fff", fontSize: 16, fontWeight: "700" },
  refresh: { color: "#F97316", fontSize: 14, fontWeight: "600" },
  loadingWrap: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingVertical: 16,
  },
  loadingText: { color: "#94A3B8", fontSize: 14 },
  errorBox: {
    backgroundColor: "#7F1D1D",
    borderRadius: 8,
    padding: 12,
    marginBottom: 12,
  },
  errorText: { color: "#FECACA", fontSize: 14, lineHeight: 20 },
  empty: { color: "#94A3B8", fontSize: 14, lineHeight: 20, paddingVertical: 8 },
  card: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "#1E293B",
    borderRadius: 12,
    padding: 14,
    marginBottom: 10,
  },
  cardName: { color: "#fff", fontSize: 15, fontWeight: "600" },
  cardAddr: { color: "#94A3B8", fontSize: 12, marginTop: 2 },
  testBtn: {
    backgroundColor: "#F97316",
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: 8,
    minWidth: 100,
    alignItems: "center",
  },
  testBtnPressed: { opacity: 0.7 },
  testBtnDisabled: { opacity: 0.4 },
  testBtnText: { color: "#fff", fontSize: 14, fontWeight: "600" },
  foot: {
    color: "#64748B",
    fontSize: 12,
    fontStyle: "italic",
    lineHeight: 18,
  },
  agentCard: {
    backgroundColor: "#1E293B",
    borderRadius: 12,
    padding: 16,
    marginBottom: 8,
  },
  agentMeta: { color: "#94A3B8", fontSize: 13, marginTop: 6 },
  statusPill: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 999,
  },
  statusPillOn: { backgroundColor: "#16A34A" },
  statusPillWarn: { backgroundColor: "#CA8A04" },
  statusPillOff: { backgroundColor: "#475569" },
  statusPillText: { color: "#fff", fontSize: 12, fontWeight: "600" },
  pairInput: {
    backgroundColor: "#0F172A",
    color: "#fff",
    fontSize: 24,
    fontWeight: "700",
    letterSpacing: 4,
    textAlign: "center",
    paddingVertical: 14,
    borderRadius: 10,
    marginTop: 12,
    marginBottom: 12,
    borderWidth: 1,
    borderColor: "#334155",
  },
  pairBtn: {
    backgroundColor: "#F97316",
    paddingVertical: 14,
    borderRadius: 10,
    alignItems: "center",
  },
  pairBtnPressed: { opacity: 0.7 },
  pairBtnDisabled: { opacity: 0.4 },
  pairBtnText: { color: "#fff", fontSize: 16, fontWeight: "600" },
  unpairBtn: {
    marginTop: 14,
    paddingVertical: 10,
    borderRadius: 10,
    alignItems: "center",
    borderWidth: 1,
    borderColor: "#475569",
  },
  unpairBtnText: { color: "#94A3B8", fontSize: 14, fontWeight: "500" },
  errorInline: {
    color: "#F87171",
    fontSize: 12,
    marginTop: 8,
  },
});
