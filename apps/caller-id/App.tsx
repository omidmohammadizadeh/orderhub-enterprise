import { useEffect, useRef, useState } from "react";
import {
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import { StatusBar } from "expo-status-bar";
import ReactNativeForegroundService from "@supersami/rn-foreground-service";
import {
  CallerIdConfig,
  EMPTY_CONFIG,
  loadConfig,
  saveConfig,
} from "./src/config";
import { postRing } from "./src/api";
import {
  getNotifPermission,
  openNotifPermission,
  startCallDetection,
  stopCallDetection,
} from "./src/detectors";

type LogLine = { at: string; text: string; ok?: boolean };

export default function App() {
  const [cfg, setCfg] = useState<CallerIdConfig>(EMPTY_CONFIG);
  const [listening, setListening] = useState(false);
  const [notifStatus, setNotifStatus] = useState("unknown");
  const [log, setLog] = useState<LogLine[]>([]);
  const cfgRef = useRef(cfg);
  cfgRef.current = cfg;

  const addLog = (text: string, ok?: boolean) =>
    setLog((l) => [{ at: new Date().toLocaleTimeString(), text, ok }, ...l].slice(0, 50));

  useEffect(() => {
    loadConfig().then(setCfg);
    getNotifPermission().then(setNotifStatus);
  }, []);

  const set = (k: keyof CallerIdConfig) => (v: string) =>
    setCfg((c) => ({ ...c, [k]: v }));

  const persist = async () => {
    await saveConfig(cfg);
    addLog("Settings saved", true);
  };

  const toggleListening = async (on: boolean) => {
    await saveConfig(cfg);
    if (on) {
      // Persistent foreground notification keeps the process (and the SIM
      // listener) alive when the app is closed / backgrounded.
      try {
        ReactNativeForegroundService.start({
          id: 1144,
          title: "Order Hub Caller ID",
          message: "Watching for incoming calls",
          ServiceType: "dataSync",
        });
      } catch (e: any) {
        addLog(`Foreground service: ${e?.message ?? e}`);
      }
      startCallDetection(async (phone) => {
        const r = await postRing(cfgRef.current, phone, "SIM");
        addLog(`SIM ${phone} → ${r.detail}`, r.ok);
      }, (m) => addLog(m));
      setListening(true);
      addLog("Listening for calls (background on)", true);
    } else {
      stopCallDetection();
      try {
        ReactNativeForegroundService.stop();
      } catch {
        /* ignore */
      }
      setListening(false);
      addLog("Stopped");
    }
  };

  const testSend = async () => {
    const r = await postRing(cfg, "+447700900123", "SIM");
    addLog(`Test popup → ${r.detail}`, r.ok);
  };

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
      <StatusBar style="light" />
      <Text style={styles.h1}>Order Hub Caller ID</Text>
      <Text style={styles.sub}>
        Catches incoming calls on this phone and pops them on your POS tablets.
      </Text>

      <Text style={styles.label}>API base URL</Text>
      <TextInput
        style={styles.input}
        value={cfg.apiBase}
        onChangeText={set("apiBase")}
        autoCapitalize="none"
        placeholder="https://orderhub-api-0re6.onrender.com"
        placeholderTextColor="#64748b"
      />

      <Text style={styles.label}>Location ID (which shop)</Text>
      <TextInput
        style={styles.input}
        value={cfg.locationId}
        onChangeText={set("locationId")}
        autoCapitalize="none"
        placeholder="cmp..."
        placeholderTextColor="#64748b"
      />

      <Text style={styles.label}>Webhook key (VOIP_WEBHOOK_KEY)</Text>
      <TextInput
        style={styles.input}
        value={cfg.key}
        onChangeText={set("key")}
        autoCapitalize="none"
        secureTextEntry
        placeholder="shared secret from Render"
        placeholderTextColor="#64748b"
      />

      <Text style={styles.label}>VoIP app package(s) to watch (optional)</Text>
      <TextInput
        style={styles.input}
        value={cfg.voipPackages}
        onChangeText={set("voipPackages")}
        autoCapitalize="none"
        placeholder="e.g. com.voipprovider.app (blank = all apps)"
        placeholderTextColor="#64748b"
      />

      <TouchableOpacity style={styles.btn} onPress={persist}>
        <Text style={styles.btnText}>Save settings</Text>
      </TouchableOpacity>

      <View style={styles.rowBetween}>
        <Text style={styles.rowLabel}>Listen for SIM calls</Text>
        <Switch value={listening} onValueChange={toggleListening} />
      </View>

      <View style={styles.card}>
        <Text style={styles.cardTitle}>VoIP calls (notification access)</Text>
        <Text style={styles.cardBody}>
          Status: <Text style={{ fontWeight: "700" }}>{notifStatus}</Text>. To
          catch VoIP-app calls, grant Notification Access, then reopen this app.
        </Text>
        <TouchableOpacity
          style={[styles.btn, styles.btnGhost]}
          onPress={() => {
            openNotifPermission();
            setTimeout(() => getNotifPermission().then(setNotifStatus), 1500);
          }}
        >
          <Text style={styles.btnGhostText}>Open Notification Access</Text>
        </TouchableOpacity>
      </View>

      <TouchableOpacity style={[styles.btn, styles.btnGhost]} onPress={testSend}>
        <Text style={styles.btnGhostText}>Send test popup to POS</Text>
      </TouchableOpacity>

      <Text style={styles.label}>Activity</Text>
      <View style={styles.logBox}>
        {log.length === 0 && <Text style={styles.logEmpty}>No calls yet.</Text>}
        {log.map((l, i) => (
          <Text key={i} style={[styles.logLine, l.ok === false && styles.logBad, l.ok && styles.logGood]}>
            {l.at}  {l.text}
          </Text>
        ))}
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: "#0f172a" },
  content: { padding: 20, paddingTop: 60, gap: 6 },
  h1: { color: "#f8fafc", fontSize: 24, fontWeight: "800" },
  sub: { color: "#94a3b8", fontSize: 13, marginBottom: 12 },
  label: { color: "#cbd5e1", fontSize: 12, marginTop: 12, marginBottom: 4, fontWeight: "600" },
  input: {
    backgroundColor: "#1e293b",
    color: "#f1f5f9",
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 14,
    borderWidth: 1,
    borderColor: "#334155",
  },
  btn: { backgroundColor: "#22c55e", borderRadius: 10, paddingVertical: 13, alignItems: "center", marginTop: 16 },
  btnText: { color: "#04140b", fontWeight: "700", fontSize: 15 },
  btnGhost: { backgroundColor: "transparent", borderWidth: 1, borderColor: "#334155", marginTop: 10 },
  btnGhostText: { color: "#e2e8f0", fontWeight: "600", fontSize: 14 },
  rowBetween: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginTop: 18 },
  rowLabel: { color: "#f1f5f9", fontSize: 16, fontWeight: "600" },
  card: { backgroundColor: "#111c33", borderRadius: 12, padding: 14, marginTop: 18, borderWidth: 1, borderColor: "#233252" },
  cardTitle: { color: "#f1f5f9", fontSize: 15, fontWeight: "700", marginBottom: 4 },
  cardBody: { color: "#94a3b8", fontSize: 13, lineHeight: 19 },
  logBox: { backgroundColor: "#0b1220", borderRadius: 8, padding: 12, marginTop: 6, minHeight: 120, borderWidth: 1, borderColor: "#1e293b" },
  logEmpty: { color: "#475569", fontStyle: "italic" },
  logLine: { color: "#cbd5e1", fontSize: 12, fontFamily: "monospace", marginBottom: 3 },
  logGood: { color: "#4ade80" },
  logBad: { color: "#f87171" },
});
