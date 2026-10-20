// Map pins for the dark map. Static views on purpose: Android snapshots a
// custom marker to a bitmap, so anything animated inside one either freezes or
// keeps the map re-rendering. The "live" halo is drawn as a translucent ring.

import { StyleSheet, Text, View } from "react-native";
import { Marker } from "react-native-maps";
import { C } from "@/theme";
import { Icon } from "@/components/ui";

type LatLng = { latitude: number; longitude: number };

export function DriverMarker({ coordinate, heading }: { coordinate: LatLng; heading?: number | null }) {
  const hasHeading = heading != null && heading >= 0;
  return (
    <Marker coordinate={coordinate} anchor={{ x: 0.5, y: 0.5 }} flat zIndex={10} title="You">
      <View style={styles.puckHalo}>
        <View style={styles.puck}>
          <View style={{ transform: [{ rotate: `${hasHeading ? heading : 0}deg` }] }}>
            <Icon name={hasHeading ? "navigate" : "car-sport"} size={16} color={C.onAccent} />
          </View>
        </View>
      </View>
    </Marker>
  );
}

export function DropMarker({ coordinate, label, title }: { coordinate: LatLng; label: string; title?: string }) {
  return (
    <Marker coordinate={coordinate} anchor={{ x: 0.5, y: 1 }} zIndex={5} title={title}>
      <View style={{ alignItems: "center" }}>
        <View style={styles.drop}>
          <Text style={styles.dropText}>{label}</Text>
        </View>
        <View style={styles.dropTail} />
      </View>
    </Marker>
  );
}

const styles = StyleSheet.create({
  puckHalo: {
    width: 52,
    height: 52,
    borderRadius: 26,
    backgroundColor: "rgba(30,214,127,0.18)",
    borderWidth: 1,
    borderColor: "rgba(30,214,127,0.35)",
    alignItems: "center",
    justifyContent: "center",
  },
  puck: {
    width: 30,
    height: 30,
    borderRadius: 15,
    backgroundColor: C.go,
    borderWidth: 3,
    borderColor: "#fff",
    alignItems: "center",
    justifyContent: "center",
  },
  drop: {
    minWidth: 36,
    height: 36,
    paddingHorizontal: 8,
    borderRadius: 11,
    backgroundColor: C.text,
    borderWidth: 3,
    borderColor: C.bg,
    alignItems: "center",
    justifyContent: "center",
  },
  dropText: { color: C.bg, fontWeight: "900", fontSize: 14 },
  dropTail: {
    width: 0,
    height: 0,
    borderLeftWidth: 7,
    borderRightWidth: 7,
    borderTopWidth: 8,
    borderLeftColor: "transparent",
    borderRightColor: "transparent",
    borderTopColor: C.text,
    marginTop: -2,
  },
});
