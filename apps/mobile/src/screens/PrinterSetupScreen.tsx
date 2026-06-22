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

interface Props {
  visible: boolean;
  onClose: () => void;
}

export function PrinterSetupScreen({ visible, onClose }: Props) {
  const [devices, setDevices] = useState<PairedBtDevice[]>([]);
  const [loading, setLoading] = useState(false);
  const [btEnabled, setBtEnabled] = useState<boolean | null>(null);
  const [printingAddress, setPrintingAddress] = useState<string | null>(null);
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
});
