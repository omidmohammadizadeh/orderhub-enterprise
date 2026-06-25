// Background GPS streaming — pushes the driver's position to /v1/driver/ping
// so the dispatch map's live arrow follows them, even when the app is
// backgrounded (foreground service on Android, background location on iOS).

/* eslint-disable @typescript-eslint/no-explicit-any */

import * as Location from "expo-location";
import * as TaskManager from "expo-task-manager";
import { sendPing } from "./auth";

export const LOCATION_TASK = "orderhub-driver-location";

TaskManager.defineTask(LOCATION_TASK, async ({ data, error }: any) => {
  if (error) return;
  const loc = data?.locations?.[0];
  if (!loc) return;
  try {
    await sendPing({
      lat: loc.coords.latitude,
      lng: loc.coords.longitude,
      heading: loc.coords.heading ?? undefined,
      speed: loc.coords.speed ?? undefined,
    });
  } catch {
    // best-effort — drop the ping if offline
  }
});

export async function startLocationUpdates(): Promise<boolean> {
  const fg = await Location.requestForegroundPermissionsAsync();
  if (fg.status !== "granted") return false;
  try {
    await Location.requestBackgroundPermissionsAsync();
  } catch {
    // background optional — foreground pings still work while app is open
  }
  const already = await Location.hasStartedLocationUpdatesAsync(LOCATION_TASK).catch(() => false);
  if (!already) {
    await Location.startLocationUpdatesAsync(LOCATION_TASK, {
      accuracy: Location.Accuracy.Balanced,
      timeInterval: 8000,
      distanceInterval: 25,
      pausesUpdatesAutomatically: false,
      showsBackgroundLocationIndicator: false,
      foregroundService: {
        notificationTitle: "Order Hub Driver",
        notificationBody: "Sharing your location with dispatch",
      },
    });
  }
  return true;
}

export async function stopLocationUpdates(): Promise<void> {
  const started = await Location.hasStartedLocationUpdatesAsync(LOCATION_TASK).catch(() => false);
  if (started) await Location.stopLocationUpdatesAsync(LOCATION_TASK);
}

/** One-off current position (for an immediate ping when going online). */
export async function pingNow(): Promise<void> {
  try {
    const pos = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
    await sendPing({
      lat: pos.coords.latitude,
      lng: pos.coords.longitude,
      heading: pos.coords.heading ?? undefined,
      speed: pos.coords.speed ?? undefined,
    });
  } catch {
    // ignore
  }
}
