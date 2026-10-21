import * as Notifications from "expo-notifications";
import { useCallback, useEffect, useState } from "react";
import { AppState, Linking } from "react-native";
import { multiShop } from "./shop";
import { getPushToken, registerOnLaunch } from "./push";

// What the app may do on this phone, and how to ask for the rest. A choice
// the customer made by mistake ("Don't allow") can't be re-asked in-app, so
// the only way back is the phone's own Settings page for this app.

export type Access = "on" | "ask" | "settings";

function fromStatus(status: string, canAskAgain: boolean): Access {
  if (status === "granted") return "on";
  return canAskAgain ? "ask" : "settings";
}

export async function notificationAccess(): Promise<Access> {
  const p = await Notifications.getPermissionsAsync();
  return fromStatus(p.status, p.canAskAgain);
}

/** Location is only asked for by multi-shop apps (to sort shops by
 *  distance); single-shop builds don't carry the permission at all. Loaded
 *  lazily, like the shop picker does. */
export async function locationAccess(): Promise<Access | null> {
  if (!multiShop) return null;
  try {
    const Location = await import("expo-location");
    const p = await Location.getForegroundPermissionsAsync();
    return fromStatus(p.status, p.canAskAgain);
  } catch {
    return null;
  }
}

export async function allowNotifications(): Promise<Access> {
  const now = await notificationAccess();
  if (now === "settings") {
    await Linking.openSettings().catch(() => {});
    return now;
  }
  if (now === "ask") {
    await getPushToken();
    await registerOnLaunch();
  }
  return notificationAccess();
}

export async function allowLocation(): Promise<Access | null> {
  const now = await locationAccess();
  if (now === "settings") {
    await Linking.openSettings().catch(() => {});
    return now;
  }
  if (now === "ask") {
    try {
      const Location = await import("expo-location");
      await Location.requestForegroundPermissionsAsync();
    } catch {
      /* no module in this build */
    }
  }
  return locationAccess();
}

/** Both, re-read whenever the app comes back to the front — the customer
 *  may have just flipped them in Settings. */
export function useAccess() {
  const [notifications, setNotifications] = useState<Access | null>(null);
  const [location, setLocation] = useState<Access | null>(null);

  const refresh = useCallback(() => {
    notificationAccess().then(setNotifications).catch(() => {});
    locationAccess().then(setLocation).catch(() => {});
  }, []);

  useEffect(() => {
    refresh();
    const sub = AppState.addEventListener("change", (s) => {
      if (s === "active") refresh();
    });
    return () => sub.remove();
  }, [refresh]);

  return {
    notifications,
    location,
    refresh,
    allowNotifications: async () => setNotifications(await allowNotifications()),
    allowLocation: async () => setLocation(await allowLocation()),
  };
}
