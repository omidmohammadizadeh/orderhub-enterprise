import { Modal, Platform, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { Icon } from "@/components/ui";
import { C, R } from "@/theme";

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
          <View style={styles.icon}>
            <Icon name="location" size={28} color={C.onAccent} />
          </View>
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
    backgroundColor: C.overlay,
    alignItems: "center",
    justifyContent: "center",
    padding: 24,
  },
  card: {
    width: "100%",
    maxWidth: 420,
    backgroundColor: C.surface,
    borderRadius: R.xl,
    borderWidth: 1,
    borderColor: C.border,
    padding: 22,
  },
  icon: {
    alignSelf: "center",
    width: 60,
    height: 60,
    borderRadius: 30,
    backgroundColor: C.go,
    alignItems: "center",
    justifyContent: "center",
  },
  title: { fontSize: 21, fontWeight: "900", color: C.text, textAlign: "center", marginTop: 12, marginBottom: 12 },
  body: { fontSize: 15, lineHeight: 22, color: C.textDim },
  bold: { fontWeight: "800", color: C.text },
  accept: {
    marginTop: 18,
    backgroundColor: C.go,
    borderRadius: R.md,
    paddingVertical: 16,
    alignItems: "center",
  },
  acceptText: { color: C.onAccent, fontWeight: "900", fontSize: 16 },
  decline: { marginTop: 10, paddingVertical: 10, alignItems: "center" },
  declineText: { color: C.textDim, fontWeight: "700", fontSize: 15 },
});
