// Account — profile, phone check, addresses, marketing consent, sign out and
// account deletion (App Store guideline 5.1.1(v)).

import { useNavigation } from "@react-navigation/native";
import { Alert, ScrollView, StyleSheet, Switch, View } from "react-native";
import Animated from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { deleteAccount, setMarketing } from "@/api/efl";
import { useSession } from "@/auth/session";
import { TagMark } from "@/components/Bits";
import { Icon, type IconName } from "@/components/Icon";
import { PressScale } from "@/components/PressScale";
import { T } from "@/components/T";
import { MOCK } from "@/config";
import { fadeUp } from "@/lib/motion";
import { useAddressList } from "@/state/address";
import { signOut } from "@/state/accountSync";
import { unregisterOrderUpdates } from "@/lib/push";
import { C, F } from "@/theme";

function Row({ icon, title, sub, onPress, right, danger }: { icon: IconName; title: string; sub?: string; onPress?: () => void; right?: React.ReactNode; danger?: boolean }) {
  return (
    <PressScale onPress={onPress} disabled={!onPress} scaleTo={0.98} style={styles.row}>
      <View style={styles.rowIcon}>
        <Icon name={icon} size={20} color={danger ? C.red : C.ink} />
      </View>
      <View style={{ flex: 1, gap: 2 }}>
        <T v="bodyStrong" style={danger ? { color: C.red } : undefined}>{title}</T>
        {sub ? <T v="sub">{sub}</T> : null}
      </View>
      {right ?? (onPress ? <Icon name="chevronRight" size={18} color={C.grey500} /> : null)}
    </PressScale>
  );
}

export function AccountScreen() {
  const nav = useNavigation();
  const insets = useSafeAreaInsets();
  const { customer, token, phoneVerified, marketingOptIn: optIn, setMarketingOptIn } = useSession();
  const addresses = useAddressList();

  const toggleOffers = async (next: boolean) => {
    setMarketingOptIn(next);
    try {
      await setMarketing(next);
    } catch (err) {
      setMarketingOptIn(!next);
      Alert.alert("Couldn't save that", (err as Error).message);
    }
  };

  const confirmDelete = () =>
    Alert.alert(
      "Delete your account?",
      "This permanently deletes your Eat For Less account and saved details. Orders already placed stay with the shops. This can't be undone.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Delete account",
          style: "destructive",
          onPress: async () => {
            try {
              await unregisterOrderUpdates();
              await deleteAccount();
              await useSession.getState().signOut();
              Alert.alert("Account deleted", "Sorry to see you go.");
            } catch (err) {
              Alert.alert("Couldn't delete your account", (err as Error).message);
            }
          },
        },
      ],
    );

  return (
    <ScrollView style={styles.root} contentContainerStyle={{ paddingTop: insets.top + 16, paddingHorizontal: 16, paddingBottom: 140, gap: 18 }}>
      <Animated.View entering={fadeUp(0)} style={styles.profile}>
        <View style={styles.avatar}>
          <T style={styles.avatarText}>{customer ? customer.firstName[0]?.toUpperCase() : "?"}</T>
        </View>
        <View style={{ flex: 1, gap: 2 }}>
          <T v="h2">{customer ? `${customer.firstName} ${customer.lastName}`.trim() : "Your account"}</T>
          <T v="sub">{customer?.email ?? "Sign in to order and track deliveries"}</T>
        </View>
      </Animated.View>

      {!token ? (
        <Animated.View entering={fadeUp(60)}>
          <PressScale onPress={() => nav.navigate("Welcome")} style={styles.primary} haptic>
            <T style={styles.primaryText}>Sign in or create account</T>
          </PressScale>
        </Animated.View>
      ) : null}

      <Animated.View entering={fadeUp(80)} style={styles.group}>
        {token ? (
          <Row
            icon="shield"
            title="Mobile number"
            sub={phoneVerified ? `${customer?.phone ?? ""} · verified` : "Not verified — needed to order"}
            onPress={phoneVerified ? undefined : () => nav.navigate("Phone")}
            right={phoneVerified ? <Icon name="check" size={18} /> : undefined}
          />
        ) : null}
        <Row icon="pin" title="Addresses" sub={addresses.length ? `${addresses.length} saved` : "Add where you'd like food delivered"} onPress={() => nav.navigate("Address")} />
        <Row icon="receipt" title="Orders" onPress={() => nav.navigate("Tabs", { screen: "Orders" })} />
      </Animated.View>

      {token ? (
        <Animated.View entering={fadeUp(120)} style={styles.group}>
          <Row
            icon="bell"
            title="Offers and news"
            sub="Deals from shops near you, by email and notification. Never shared with shops."
            right={<Switch value={optIn} onValueChange={toggleOffers} trackColor={{ true: C.ink }} />}
          />
        </Animated.View>
      ) : null}

      {token ? (
        <Animated.View entering={fadeUp(160)} style={styles.group}>
          <Row icon="logout" title="Sign out" onPress={() => void signOut()} />
          <Row icon="trash" title="Delete account" danger onPress={confirmDelete} />
        </Animated.View>
      ) : null}

      <View style={styles.footer}>
        <TagMark size={28} />
        <T v="small" style={{ fontFamily: F.regular }}>Eat For Less · v0.1.0{MOCK ? " · sample data" : ""}</T>
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: C.white },
  profile: { flexDirection: "row", alignItems: "center", gap: 14 },
  avatar: { width: 64, height: 64, borderRadius: 32, backgroundColor: C.ink, alignItems: "center", justifyContent: "center" },
  avatarText: { fontFamily: F.display, fontSize: 26, color: C.lime },
  group: { borderRadius: 18, borderWidth: 1, borderColor: C.grey200, overflow: "hidden" },
  row: { flexDirection: "row", alignItems: "center", gap: 12, paddingHorizontal: 14, paddingVertical: 14, borderBottomWidth: 1, borderBottomColor: C.line, backgroundColor: C.white },
  rowIcon: { width: 36, height: 36, borderRadius: 18, backgroundColor: C.grey100, alignItems: "center", justifyContent: "center" },
  primary: { height: 54, borderRadius: 27, backgroundColor: C.ink, alignItems: "center", justifyContent: "center" },
  primaryText: { fontFamily: F.bold, fontSize: 16, color: C.white },
  footer: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8, marginTop: 8 },
});
