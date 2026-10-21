import { StyleSheet, Text, View } from "react-native";
import { C } from "@/theme";

// Stand-in for the map in a local Android dev build with no Maps key (see
// MAP_AVAILABLE). Never shown in a store build.
export function MapPlaceholder() {
  return (
    <View style={[StyleSheet.absoluteFill, styles.wrap]} pointerEvents="none">
      {Array.from({ length: 14 }).map((_, i) => (
        <View key={`h${i}`} style={[styles.line, { top: `${i * 7.5}%`, left: 0, right: 0, height: 1 }]} />
      ))}
      {Array.from({ length: 8 }).map((_, i) => (
        <View key={`v${i}`} style={[styles.line, { left: `${i * 14}%`, top: 0, bottom: 0, width: 1 }]} />
      ))}
      <Text style={styles.text}>Map needs GOOGLE_MAPS_API_KEY_ANDROID (dev build)</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { backgroundColor: "#1b1e23", alignItems: "center", justifyContent: "center" },
  line: { position: "absolute", backgroundColor: "#262a31" },
  text: { color: C.textMute, fontSize: 12, fontWeight: "700" },
});
