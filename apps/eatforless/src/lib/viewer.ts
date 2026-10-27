// Anonymous install id, sent as `x-efl-viewer` on every API call. The server
// uses it to cap how often a sponsored shop is shown per day and to charge a
// tap on one only once. It identifies the install, never the person: it's
// created on first launch, kept in AsyncStorage (cleared on uninstall, unlike
// the Keychain) and never linked to the signed-in account on this side.

import AsyncStorage from "@react-native-async-storage/async-storage";
import * as Crypto from "expo-crypto";

const KEY = "efl.viewerId";
/** What the server accepts; anything else stored is replaced. */
const VALID = /^[A-Za-z0-9_-]{8,64}$/;

let cached: string | null = null;
let loading: Promise<string> | null = null;

function makeId(): string {
  try {
    // 32 hex chars from the platform CSPRNG.
    return Crypto.randomUUID().replace(/-/g, "");
  } catch {
    let id = "";
    while (id.length < 32) id += Math.random().toString(36).slice(2);
    return id.slice(0, 32);
  }
}

/** The install id; created and stored on first call. Never rejects — if
 *  storage fails, this run uses an in-memory id. */
export function viewerId(): Promise<string> {
  if (cached) return Promise.resolve(cached);
  if (!loading) {
    loading = (async () => {
      const stored = await AsyncStorage.getItem(KEY).catch(() => null);
      if (stored && VALID.test(stored)) return (cached = stored);
      const id = makeId();
      await AsyncStorage.setItem(KEY, id).catch(() => {});
      return (cached = id);
    })();
  }
  return loading;
}
