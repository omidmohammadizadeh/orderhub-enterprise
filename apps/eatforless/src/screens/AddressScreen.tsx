// Delivery address — pick a saved one, use the phone's location, or type one.
// Typed addresses are placed on the map with the phone's own geocoder (no API
// key needed), since GET efl/shops needs a point.

import * as Location from "expo-location";
import { useState } from "react";
import { ActivityIndicator, Alert, KeyboardAvoidingView, Platform, ScrollView, StyleSheet, TextInput, View } from "react-native";
import Animated, { FadeIn, FadeOut, LinearTransition } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { updateMe } from "@/api/efl";
import { useSession } from "@/auth/session";
import { RoundButton } from "@/components/Bits";
import { Icon } from "@/components/Icon";
import { PressScale } from "@/components/PressScale";
import { T } from "@/components/T";
import type { RootScreen } from "@/navigation/types";
import { useAddresses, type Address } from "@/state/address";
import { C, F } from "@/theme";

const blank = { line1: "", line2: "", city: "Newcastle upon Tyne", postcode: "", instructions: "" };

export function AddressScreen({ navigation }: RootScreen<"Address">) {
  const insets = useSafeAreaInsets();
  const { addresses, selectedId, save, select, remove } = useAddresses();
  const signedIn = useSession((s) => !!s.token);
  const [form, setForm] = useState<typeof blank | null>(addresses.length ? null : blank);
  const [coords, setCoords] = useState<{ lat: number; lng: number } | null>(null);
  const [busy, setBusy] = useState<null | "locate" | "save">(null);

  const set = (k: keyof typeof blank) => (v: string) => setForm((f) => (f ? { ...f, [k]: v } : f));

  const locate = async () => {
    setBusy("locate");
    try {
      const perm = await Location.requestForegroundPermissionsAsync();
      if (perm.status !== "granted") {
        Alert.alert("Location is off", "Type your address instead, or allow location in Settings.");
        return;
      }
      const here = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
      const [place] = await Location.reverseGeocodeAsync(here.coords);
      setCoords({ lat: here.coords.latitude, lng: here.coords.longitude });
      setForm({
        line1: [place?.streetNumber, place?.street].filter(Boolean).join(" ") || place?.name || "",
        line2: "",
        city: place?.city ?? place?.subregion ?? "Newcastle upon Tyne",
        postcode: place?.postalCode ?? "",
        instructions: "",
      });
    } catch {
      Alert.alert("Couldn't find you", "Type your address instead.");
    } finally {
      setBusy(null);
    }
  };

  const submit = async () => {
    if (!form) return;
    setBusy("save");
    try {
      let point = coords;
      if (!point) {
        const [hit] = await Location.geocodeAsync(`${form.line1}, ${form.city}, ${form.postcode}, UK`);
        if (!hit) throw new Error("We couldn't find that address. Check the postcode.");
        point = { lat: hit.latitude, lng: hit.longitude };
      }
      const address: Address = {
        id: `addr-${Date.now()}`,
        line1: form.line1.trim(),
        line2: form.line2.trim() || undefined,
        city: form.city.trim(),
        postcode: form.postcode.trim().toUpperCase(),
        instructions: form.instructions.trim() || undefined,
        ...point,
      };
      save(address);
      // The account keeps one address; keep it in step with the latest used.
      if (signedIn) {
        void updateMe({
          addressLine1: address.line1,
          addressLine2: address.line2 ?? null,
          addressCity: address.city,
          addressPostcode: address.postcode,
        }).catch(() => {});
      }
      navigation.goBack();
    } catch (err) {
      Alert.alert("Address not found", (err as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const valid = !!form && form.line1.trim().length > 2 && form.city.trim().length > 1 && /^[A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2}$/i.test(form.postcode.trim());

  return (
    <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined} style={styles.root}>
      <View style={[styles.header, { paddingTop: Platform.OS === "ios" ? 16 : insets.top + 8 }]}>
        <T v="h1">{form ? "Add address" : "Deliver to"}</T>
        <RoundButton icon="close" label="Close" light onPress={() => (form && addresses.length ? setForm(null) : navigation.goBack())} />
      </View>
      <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ padding: 16, gap: 12, paddingBottom: insets.bottom + 30 }}>
        <PressScale onPress={locate} style={styles.locate} haptic>
          {busy === "locate" ? <ActivityIndicator color={C.ink} /> : <Icon name="locate" size={20} />}
          <T v="label" style={{ fontSize: 15 }}>Use my current location</T>
        </PressScale>

        {form ? (
          <Animated.View entering={FadeIn} style={{ gap: 10 }}>
            <Field label="Street address" value={form.line1} onChangeText={set("line1")} placeholder="14 Grey Street" autoComplete="street-address" />
            <Field label="Flat, floor or building (optional)" value={form.line2} onChangeText={set("line2")} placeholder="Flat 3" />
            <View style={{ flexDirection: "row", gap: 10 }}>
              <Field style={{ flex: 1.4 }} label="Town" value={form.city} onChangeText={set("city")} />
              <Field style={{ flex: 1 }} label="Postcode" value={form.postcode} onChangeText={set("postcode")} autoCapitalize="characters" placeholder="NE1 6AE" autoComplete="postal-code" />
            </View>
            <Field label="Note for the driver (optional)" value={form.instructions} onChangeText={set("instructions")} placeholder="Ring the bell, side door…" />
            <PressScale onPress={submit} disabled={!valid || !!busy} style={[styles.primary, (!valid || !!busy) && { opacity: 0.35 }]} haptic>
              {busy === "save" ? <ActivityIndicator color={C.white} /> : <T style={styles.primaryText}>Save address</T>}
            </PressScale>
          </Animated.View>
        ) : (
          <>
            {addresses.map((a) => {
              const on = a.id === selectedId;
              return (
                <Animated.View key={a.id} layout={LinearTransition} exiting={FadeOut}>
                  <PressScale
                    onPress={() => {
                      select(a.id);
                      navigation.goBack();
                    }}
                    style={[styles.addr, on && { borderColor: C.ink }]}
                    scaleTo={0.98}
                  >
                    <Icon name="pin" size={22} />
                    <View style={{ flex: 1, gap: 2 }}>
                      <T v="item" style={{ fontSize: 15 }}>{a.line1}</T>
                      <T v="sub">{[a.line2, a.city, a.postcode].filter(Boolean).join(", ")}</T>
                    </View>
                    <PressScale onPress={() => remove(a.id)} accessibilityLabel={`Remove ${a.line1}`} hitSlop={10}>
                      <Icon name="trash" size={18} color={C.grey600} />
                    </PressScale>
                  </PressScale>
                </Animated.View>
              );
            })}
            <PressScale onPress={() => { setCoords(null); setForm(blank); }} style={styles.addNew}>
              <Icon name="plus" size={18} />
              <T v="label" style={{ fontSize: 15 }}>Add a new address</T>
            </PressScale>
          </>
        )}
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

function Field({ label, style, ...rest }: React.ComponentProps<typeof TextInput> & { label: string }) {
  return (
    <View style={[{ gap: 6 }, style]}>
      <T v="small" style={{ color: C.ink }}>{label}</T>
      <TextInput placeholderTextColor={C.grey400} style={styles.input} {...rest} />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: C.white },
  header: { paddingHorizontal: 16, paddingBottom: 4, flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  locate: { flexDirection: "row", alignItems: "center", gap: 12, height: 56, borderRadius: 16, backgroundColor: C.grey100, paddingHorizontal: 16 },
  input: { height: 50, borderRadius: 14, backgroundColor: C.grey100, paddingHorizontal: 14, fontFamily: F.regular, fontSize: 16, color: C.ink },
  addr: { flexDirection: "row", alignItems: "center", gap: 12, padding: 14, borderRadius: 16, borderWidth: 2, borderColor: C.grey200 },
  addNew: { flexDirection: "row", alignItems: "center", gap: 10, height: 52, paddingHorizontal: 4 },
  primary: { height: 54, borderRadius: 27, backgroundColor: C.ink, alignItems: "center", justifyContent: "center", marginTop: 6 },
  primaryText: { fontFamily: F.bold, fontSize: 16, color: C.white },
});
