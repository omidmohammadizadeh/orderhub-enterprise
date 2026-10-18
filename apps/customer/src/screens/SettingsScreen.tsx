import { Ionicons } from "@expo/vector-icons";
import { useFocusEffect } from "@react-navigation/native";
import Constants from "expo-constants";
import * as Linking from "expo-linking";
import * as Notifications from "expo-notifications";
import { type ReactNode, useCallback, useState } from "react";
import { Alert, Pressable, ScrollView, StyleSheet, Switch, Text, View } from "react-native";
import { deleteAccount, refreshCustomer, signOut, useAuth } from "../auth";
import { brand, withBrandQuery } from "../brand";
import { SignInButtons } from "../components/SignInButtons";
import { openStorefront } from "../navigation";
import { getOffersPreference, getPushToken, registerOnLaunch, setOffers } from "../push";
import { slugFromUrl } from "../storefront-bridge";
import { colors, radius } from "../theme";

function Row({ icon, title, detail, right, onPress }: {
  icon: keyof typeof Ionicons.glyphMap;
  title: string;
  detail?: string;
  right?: ReactNode;
  onPress?: () => void;
}) {
  const body = (
    <>
      <Ionicons name={icon} size={22} color={colors.primary} />
      <View style={{ flex: 1 }}>
        <Text style={styles.rowTitle}>{title}</Text>
        {detail ? <Text style={styles.rowDetail}>{detail}</Text> : null}
      </View>
      {right ?? (onPress ? <Ionicons name="chevron-forward" size={18} color={colors.muted} /> : null)}
    </>
  );
  // Nothing to tap → a plain View, so the row never competes with a Switch.
  if (!onPress) return <View style={styles.row}>{body}</View>;
  return (
    <Pressable onPress={onPress} style={({ pressed }) => [styles.row, pressed && { opacity: 0.6 }]}>
      {body}
    </Pressable>
  );
}

export function SettingsScreen() {
  const [offers, setOffersState] = useState(false);
  const [permission, setPermission] = useState<Notifications.PermissionStatus | null>(null);
  const slug = slugFromUrl(brand.storefrontUrl);
  const auth = useAuth();
  const signedIn = !!auth.token;
  const who = auth.customer;
  const name = [who?.firstName, who?.lastName].filter(Boolean).join(" ");

  useFocusEffect(
    useCallback(() => {
      getOffersPreference().then((v) => setOffersState(v === true));
      Notifications.getPermissionsAsync().then((p) => setPermission(p.status));
      refreshCustomer();
    }, []),
  );

  const confirmSignOut = () =>
    Alert.alert("Sign out?", undefined, [
      { text: "Cancel", style: "cancel" },
      { text: "Sign out", style: "destructive", onPress: signOut },
    ]);

  const confirmDelete = () =>
    Alert.alert(
      "Delete your account?",
      "Your saved details, addresses and rewards are deleted for good. Orders you've placed stay with the restaurant.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Delete",
          style: "destructive",
          onPress: () =>
            deleteAccount().catch((err) => Alert.alert("Couldn't delete your account", err?.message ?? "Please try again.")),
        },
      ],
    );

  const toggleOffers = async (on: boolean) => {
    setOffersState(on);
    // Turning offers on needs notifications on: ask now if we never got a token.
    if (on && permission !== "granted") {
      await getPushToken();
      setPermission((await Notifications.getPermissionsAsync()).status);
      await registerOnLaunch();
    }
    await setOffers(on);
  };

  const notificationsOn = permission === "granted";

  return (
    <ScrollView style={styles.root} contentContainerStyle={styles.content}>
      <Text style={styles.section}>Notifications</Text>
      <View style={styles.group}>
        <Row
          icon="notifications-outline"
          title="Order updates"
          detail={
            notificationsOn
              ? "We'll tell you when your order is accepted, ready and on its way."
              : "Turned off — tap to allow notifications in Settings."
          }
          onPress={notificationsOn ? undefined : () => Linking.openSettings()}
        />
        <View style={styles.divider} />
        <Row
          icon="pricetag-outline"
          title="Offers & news"
          detail={`Deals and news from ${brand.name}.`}
          right={
            <Switch
              value={offers}
              onValueChange={toggleOffers}
              trackColor={{ true: colors.primary, false: colors.border }}
              accessibilityLabel="Offers and news"
            />
          }
        />
      </View>

      <Text style={styles.section}>Account</Text>
      <View style={styles.group}>
        {signedIn ? (
          <>
            <Row
              icon="person-outline"
              title={name || who?.email || "Signed in"}
              detail={name && who?.email ? who.email : undefined}
            />
            <View style={styles.divider} />
          </>
        ) : (
          <>
            <Row
              icon="log-in-outline"
              title="Sign in"
              detail="Save your details and collect rewards on every order."
              onPress={() => openStorefront(withBrandQuery(`/order/${slug}/account`))}
            />
            <SignInButtons />
            <View style={styles.divider} />
          </>
        )}
        <Row
          icon="person-circle-outline"
          title="Your account"
          detail="Saved details, addresses and rewards"
          onPress={() => openStorefront(withBrandQuery(`/order/${slug}/account`))}
        />
        <View style={styles.divider} />
        <Row
          icon="gift-outline"
          title="Rewards"
          onPress={() => openStorefront(withBrandQuery(`/order/${slug}/rewards`))}
        />
        {signedIn ? (
          <>
            <View style={styles.divider} />
            <Row icon="log-out-outline" title="Sign out" onPress={confirmSignOut} />
            <View style={styles.divider} />
            <Row icon="trash-outline" title="Delete account" onPress={confirmDelete} />
          </>
        ) : null}
      </View>

      <Text style={styles.footer}>
        {brand.name} · version {Constants.expoConfig?.version}
        {"\n"}Powered by OrderHub
      </Text>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.background },
  content: { padding: 16, paddingBottom: 40 },
  section: {
    fontSize: 13,
    fontWeight: "700",
    color: colors.muted,
    textTransform: "uppercase",
    letterSpacing: 0.6,
    marginTop: 16,
    marginBottom: 8,
    marginLeft: 4,
  },
  group: { backgroundColor: colors.card, borderRadius: radius.card, overflow: "hidden" },
  row: { flexDirection: "row", alignItems: "center", gap: 14, paddingHorizontal: 16, paddingVertical: 14, minHeight: 56 },
  rowTitle: { fontSize: 16, fontWeight: "600", color: colors.text },
  rowDetail: { fontSize: 13, color: colors.muted, marginTop: 2, lineHeight: 18 },
  divider: { height: StyleSheet.hairlineWidth, backgroundColor: colors.border, marginLeft: 52 },
  footer: { textAlign: "center", color: colors.muted, fontSize: 13, marginTop: 32, lineHeight: 20 },
});
