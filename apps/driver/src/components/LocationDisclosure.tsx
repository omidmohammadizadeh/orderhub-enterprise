import { Modal, Platform, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";

// Pre-permission location notice, shown BEFORE the system location prompt.
//
// The two stores have CONFLICTING rules here, so behaviour is platform-split:
//   • Android — Google Play's "prominent disclosure" policy REQUIRES an
//     explicit consent step for background location, i.e. the driver must be
//     able to decline ("Not now" → stays offline).
//   • iOS — App Review Guideline 5.1.1(iv) FORBIDS an exit/close affordance
//     on a message shown before a permission request: the user must always
//     proceed to the system prompt (rejection 02 Jul 2026). So on iOS there
//     is a single Continue button, no "Not now", and no dismiss — the place
//     to decline is Apple's own permission dialog that follows.
export function LocationDisclosure({
  visible,
  onAccept,
  onDecline,
}: {
  visible: boolean;
  onAccept: () => void;
  onDecline: () => void;
}) {
  const canDecline = Platform.OS !== "ios";
  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      // Android hardware back = decline; on iOS the message must not be
      // dismissible without proceeding to the permission request.
      onRequestClose={canDecline ? onDecline : () => {}}
    >
      <View style={styles.backdrop}>
        <View style={styles.card}>
          <Text style={styles.icon}>📍</Text>
          <Text style={styles.title}>Location sharing</Text>
          <ScrollView style={{ maxHeight: 300 }} contentContainerStyle={{ paddingBottom: 4 }}>
            <Text style={styles.body}>
              Order Hub Driver collects your location to share it with your dispatch operator and
              the customer so they can track your delivery in real time.
              {"\n\n"}
              This includes collecting location{" "}
              <Text style={styles.bold}>in the background — even when the app is closed or not in use</Text>{" "}
              — while you are online or on an active delivery, so tracking keeps working while you
              navigate with another app or your screen is off.
              {"\n\n"}
              Location is only shared while you are online. Switch yourself offline at any time to
              stop sharing.
            </Text>
          </ScrollView>
          <Pressable style={styles.accept} onPress={onAccept}>
            <Text style={styles.acceptText}>Continue</Text>
          </Pressable>
          {canDecline && (
            <Pressable style={styles.decline} onPress={onDecline} hitSlop={8}>
              <Text style={styles.declineText}>Not now</Text>
            </Pressable>
          )}
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.55)",
    alignItems: "center",
    justifyContent: "center",
    padding: 24,
  },
  card: {
    width: "100%",
    maxWidth: 420,
    backgroundColor: "#fff",
    borderRadius: 18,
    padding: 22,
  },
  icon: { fontSize: 34, textAlign: "center" },
  title: { fontSize: 20, fontWeight: "800", color: "#0F172A", textAlign: "center", marginTop: 6, marginBottom: 12 },
  body: { fontSize: 15, lineHeight: 22, color: "#334155" },
  bold: { fontWeight: "800", color: "#0F172A" },
  accept: {
    marginTop: 18,
    backgroundColor: "#16a34a",
    borderRadius: 12,
    paddingVertical: 15,
    alignItems: "center",
  },
  acceptText: { color: "#fff", fontWeight: "800", fontSize: 16 },
  decline: { marginTop: 10, paddingVertical: 10, alignItems: "center" },
  declineText: { color: "#64748b", fontWeight: "700", fontSize: 15 },
});
