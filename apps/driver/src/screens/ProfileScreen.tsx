import { useEffect, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { DriverProfile, changePassword, deleteMyAccount, getMe } from "@/services/auth";

export function ProfileScreen({
  onBack,
  onSignOut,
}: {
  onBack: () => void;
  onSignOut: () => void;
}) {
  const [me, setMe] = useState<DriverProfile | null>(null);
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    getMe().then(setMe).catch(() => {});
  }, []);

  async function savePassword() {
    if (newPassword.length < 8) {
      Alert.alert("Password too short", "Use at least 8 characters.");
      return;
    }
    setBusy(true);
    try {
      await changePassword(newPassword, currentPassword || undefined);
      setCurrentPassword("");
      setNewPassword("");
      Alert.alert("Updated", "Your password has been changed.");
    } catch (err) {
      Alert.alert("Error", (err as Error)?.message ?? "Try again");
    } finally {
      setBusy(false);
    }
  }

  function confirmDelete() {
    Alert.alert(
      "Delete account?",
      "This permanently deletes your account and cannot be undone.",
      [
        { text: "Cancel", style: "cancel" },
        { text: "Delete", style: "destructive", onPress: doDelete },
      ],
    );
  }

  async function doDelete() {
    setBusy(true);
    try {
      await deleteMyAccount();
      onSignOut();
    } catch (err) {
      Alert.alert("Error", (err as Error)?.message ?? "Try again");
      setBusy(false);
    }
  }

  return (
    <View style={styles.container}>
      <View style={styles.topbar}>
        <Pressable onPress={onBack} hitSlop={10}>
          <Text style={styles.back}>‹ Back</Text>
        </Pressable>
        <Text style={styles.title}>Profile</Text>
        <View style={{ width: 50 }} />
      </View>

      <ScrollView contentContainerStyle={{ padding: 16 }}>
        <View style={styles.card}>
          <Text style={styles.name}>
            {me ? `${me.firstName} ${me.lastName}` : "Driver"}
          </Text>
          {!!me?.phone && <Text style={styles.meta}>{me.phone}</Text>}
          {!!me?.vehicleType && <Text style={styles.meta}>{me.vehicleType}</Text>}
        </View>

        <Text style={styles.section}>Change password</Text>
        <TextInput
          style={styles.input}
          placeholder="Current password (if you have one)"
          placeholderTextColor="#94a3b8"
          secureTextEntry
          value={currentPassword}
          onChangeText={setCurrentPassword}
        />
        <TextInput
          style={styles.input}
          placeholder="New password (min 8 characters)"
          placeholderTextColor="#94a3b8"
          secureTextEntry
          value={newPassword}
          onChangeText={setNewPassword}
        />
        <Pressable style={[styles.primary, busy && { opacity: 0.6 }]} disabled={busy} onPress={savePassword}>
          {busy ? <ActivityIndicator color="#fff" /> : <Text style={styles.primaryText}>Update password</Text>}
        </Pressable>

        <Text style={styles.section}>Danger zone</Text>
        <Pressable style={styles.deleteBtn} disabled={busy} onPress={confirmDelete}>
          <Text style={styles.deleteText}>Delete my account</Text>
        </Pressable>
        <Text style={styles.dangerNote}>
          Permanently deletes your account. This cannot be undone.
        </Text>
      </ScrollView>
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
  card: { backgroundColor: "#fff", borderRadius: 12, padding: 16 },
  name: { fontSize: 20, fontWeight: "800", color: "#0F172A" },
  meta: { color: "#64748b", marginTop: 4 },
  section: {
    color: "#475569",
    fontSize: 12,
    fontWeight: "800",
    textTransform: "uppercase",
    marginTop: 24,
    marginBottom: 10,
  },
  input: {
    backgroundColor: "#fff",
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 13,
    marginBottom: 10,
    fontSize: 15,
    borderWidth: 1,
    borderColor: "#e2e8f0",
  },
  primary: { backgroundColor: "#f97316", borderRadius: 10, paddingVertical: 14, alignItems: "center", marginTop: 2 },
  primaryText: { color: "#fff", fontWeight: "800", fontSize: 15 },
  deleteBtn: {
    backgroundColor: "#fee2e2",
    borderRadius: 10,
    paddingVertical: 14,
    alignItems: "center",
    borderWidth: 1,
    borderColor: "#fca5a5",
  },
  deleteText: { color: "#dc2626", fontWeight: "800", fontSize: 15 },
  dangerNote: { color: "#94a3b8", fontSize: 12, marginTop: 8 },
});
