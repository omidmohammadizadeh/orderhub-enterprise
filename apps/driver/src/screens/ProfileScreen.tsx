import { useEffect, useState } from "react";
import { Alert, KeyboardAvoidingView, Platform, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { DriverProfile, changePassword, deleteMyAccount, getMe } from "@/services/auth";
import { Button, Header, Icon } from "@/components/ui";
import { C, R, initials } from "@/theme";

// The API's own message beats axios's "Request failed with status code 400" —
// e.g. "Current password is incorrect".
function apiMessage(err: unknown): string {
  const detail = (err as { response?: { data?: { message?: string | string[] } } })?.response?.data?.message;
  if (Array.isArray(detail)) return detail.join("\n");
  return detail || (err as Error)?.message || "Try again";
}

export function ProfileScreen({ onBack, onSignOut }: { onBack: () => void; onSignOut: () => void }) {
  const insets = useSafeAreaInsets();
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
      Alert.alert("Couldn't change password", apiMessage(err));
    } finally {
      setBusy(false);
    }
  }

  function confirmDelete() {
    Alert.alert("Delete account?", "This permanently deletes your account and cannot be undone.", [
      { text: "Cancel", style: "cancel" },
      { text: "Delete", style: "destructive", onPress: doDelete },
    ]);
  }

  async function doDelete() {
    setBusy(true);
    try {
      await deleteMyAccount();
      onSignOut();
    } catch (err) {
      Alert.alert("Couldn't delete account", apiMessage(err));
      setBusy(false);
    }
  }

  return (
    <KeyboardAvoidingView style={styles.container} behavior={Platform.OS === "ios" ? "padding" : "height"}>
      <Header title="Profile" onBack={onBack} />

      <ScrollView
        contentContainerStyle={{ padding: 16, paddingBottom: Math.max(insets.bottom, 16) + 8 }}
        keyboardShouldPersistTaps="handled"
      >
        <View style={styles.card}>
          <View style={styles.avatar}>
            <Text style={styles.avatarText}>{initials(me?.firstName, me?.lastName)}</Text>
          </View>
          <View style={{ flex: 1 }}>
            <Text style={styles.name}>{me ? `${me.firstName} ${me.lastName}` : "Driver"}</Text>
            {!!me?.phone && (
              <View style={styles.metaRow}>
                <Icon name="call-outline" size={14} color={C.textMute} />
                <Text style={styles.meta}>{me.phone}</Text>
              </View>
            )}
            {!!me?.vehicleType && (
              <View style={styles.metaRow}>
                <Icon name="car-sport-outline" size={14} color={C.textMute} />
                <Text style={styles.meta}>{me.vehicleType}</Text>
              </View>
            )}
          </View>
        </View>

        <Text style={styles.section}>CHANGE PASSWORD</Text>
        <TextInput
          style={styles.input}
          placeholder="Current password (if you have one)"
          placeholderTextColor={C.textMute}
          secureTextEntry
          value={currentPassword}
          onChangeText={setCurrentPassword}
        />
        <TextInput
          style={styles.input}
          placeholder="New password (min 8 characters)"
          placeholderTextColor={C.textMute}
          secureTextEntry
          value={newPassword}
          onChangeText={setNewPassword}
        />
        <Button label="Update password" icon="lock-closed" tone="light" busy={busy} onPress={savePassword} />

        <Text style={styles.section}>DANGER ZONE</Text>
        <Button label="Delete my account" icon="trash-outline" tone="danger" disabled={busy} onPress={confirmDelete} />
        <Text style={styles.dangerNote}>Permanently deletes your account. This cannot be undone.</Text>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: C.bg },
  card: {
    flexDirection: "row",
    alignItems: "center",
    gap: 14,
    backgroundColor: C.surface,
    borderRadius: R.lg,
    borderWidth: 1,
    borderColor: C.border,
    padding: 16,
  },
  avatar: {
    width: 60,
    height: 60,
    borderRadius: 30,
    backgroundColor: C.surface3,
    borderWidth: 2,
    borderColor: C.go,
    alignItems: "center",
    justifyContent: "center",
  },
  avatarText: { color: C.text, fontSize: 21, fontWeight: "900" },
  name: { fontSize: 20, fontWeight: "900", color: C.text },
  metaRow: { flexDirection: "row", alignItems: "center", gap: 6, marginTop: 4 },
  meta: { color: C.textDim },
  section: { color: C.textMute, fontSize: 11, fontWeight: "800", letterSpacing: 1.2, marginTop: 26, marginBottom: 10 },
  input: {
    backgroundColor: C.surface,
    color: C.text,
    borderRadius: R.md,
    paddingHorizontal: 14,
    height: 52,
    marginBottom: 10,
    fontSize: 15,
    borderWidth: 1,
    borderColor: C.border,
  },
  dangerNote: { color: C.textMute, fontSize: 12, marginTop: 8 },
});
