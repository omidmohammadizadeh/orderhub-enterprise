// Who's bringing the food, Uber style: photo (or initial) with the car on a
// badge, name and rating, the car in words, and the number plate in a box so
// it can be read off the street. Shows only what we know: a JET Go courier
// or a driver who hasn't entered their car is a name and an initial.

import { useState } from "react";
import { Image, StyleSheet, View } from "react-native";
import type { CourierVehicle } from "@/api/types";
import { C, F } from "@/theme";
import { Icon } from "./Icon";
import { CarArt } from "./RouteOverlay";
import { T } from "./T";

type Props = {
  name: string;
  photoUrl?: string | null;
  vehicle?: CourierVehicle | null;
  rating?: number | null;
};

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** "Silver Toyota Prius"; just "Toyota" or "Bike" when that's all there is. */
export function vehicleLine(v: CourierVehicle | null | undefined): string | null {
  if (!v) return null;
  const words = [v.colour, v.make, v.model].filter(Boolean).map((w) => cap(String(w)));
  if (words.length) return words.join(" ");
  return v.type ? cap(v.type) : null;
}

export function DriverCard({ name, photoUrl, vehicle, rating }: Props) {
  const [photoFailed, setPhotoFailed] = useState(false);
  const car = vehicleLine(vehicle);
  const isCar = !vehicle?.type || /car|van/i.test(vehicle.type);
  return (
    <View style={styles.card}>
      <View style={styles.face}>
        <View style={styles.avatar}>
          {photoUrl && !photoFailed ? (
            <Image source={{ uri: photoUrl }} style={styles.photo} onError={() => setPhotoFailed(true)} />
          ) : (
            <T style={styles.initial}>{name[0]?.toUpperCase()}</T>
          )}
        </View>
        {car && isCar ? (
          <View style={styles.carBadge}>
            <CarArt width={24} />
          </View>
        ) : null}
      </View>
      <View style={{ flex: 1, gap: 2 }}>
        <View style={styles.nameRow}>
          <T v="item" numberOfLines={1} style={{ flexShrink: 1 }}>
            {name}
          </T>
          {rating ? (
            <View style={styles.rating}>
              <Icon name="star" size={12} color={C.ink} />
              <T style={styles.ratingText}>{rating.toFixed(1)}</T>
            </View>
          ) : null}
        </View>
        <T v="sub" numberOfLines={1}>
          {car ?? "Your driver"}
        </T>
      </View>
      {vehicle?.plate ? (
        <View style={styles.plate} accessibilityLabel={`Number plate ${vehicle.plate}`}>
          <T style={styles.plateText}>{vehicle.plate}</T>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  card: { flexDirection: "row", alignItems: "center", gap: 12, padding: 12, borderWidth: 1, borderColor: C.grey200, borderRadius: 18 },
  face: { width: 60, height: 52 },
  avatar: { width: 52, height: 52, borderRadius: 26, backgroundColor: "#E9E9E9", alignItems: "center", justifyContent: "center", overflow: "hidden" },
  photo: { width: 52, height: 52 },
  initial: { fontFamily: F.display, fontSize: 20, color: C.ink },
  carBadge: {
    position: "absolute",
    right: 0,
    bottom: -2,
    width: 32,
    height: 22,
    borderRadius: 11,
    backgroundColor: C.white,
    borderWidth: 1,
    borderColor: C.grey200,
    alignItems: "center",
    justifyContent: "center",
  },
  nameRow: { flexDirection: "row", alignItems: "center", gap: 6 },
  rating: { flexDirection: "row", alignItems: "center", gap: 2, backgroundColor: C.grey100, borderRadius: 10, paddingHorizontal: 6, paddingVertical: 2 },
  ratingText: { fontFamily: F.bold, fontSize: 12, color: C.ink },
  plate: { borderWidth: 2, borderColor: C.ink, borderRadius: 6, paddingHorizontal: 8, paddingVertical: 3, backgroundColor: "#FFFFFF" },
  plateText: { fontFamily: F.heavy, fontSize: 14, letterSpacing: 1, color: C.ink },
});
