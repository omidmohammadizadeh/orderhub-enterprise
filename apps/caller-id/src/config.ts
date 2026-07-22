import AsyncStorage from "@react-native-async-storage/async-storage";

// Stored in AsyncStorage (NOT SecureStore) so the background notification
// headless task can read it too — SecureStore isn't reliable in headless JS.
export type CallerIdConfig = {
  apiBase: string; // e.g. https://orderhub-api-0re6.onrender.com
  locationId: string; // which shop the popup goes to
  key: string; // VOIP_WEBHOOK_KEY set in Render
  voipPackages: string; // comma-separated app package ids to watch for VoIP calls
};

const STORE_KEY = "orderhub.callerid.config";

export const EMPTY_CONFIG: CallerIdConfig = {
  apiBase: "https://orderhub-api-0re6.onrender.com",
  locationId: "",
  key: "",
  voipPackages: "",
};

export async function loadConfig(): Promise<CallerIdConfig> {
  try {
    const raw = await AsyncStorage.getItem(STORE_KEY);
    if (!raw) return EMPTY_CONFIG;
    return { ...EMPTY_CONFIG, ...(JSON.parse(raw) as Partial<CallerIdConfig>) };
  } catch {
    return EMPTY_CONFIG;
  }
}

export async function saveConfig(c: CallerIdConfig): Promise<void> {
  await AsyncStorage.setItem(STORE_KEY, JSON.stringify(c));
}

/** The packages we treat as VoIP dialers (lowercased, trimmed). */
export function voipPackageList(c: CallerIdConfig): string[] {
  return c.voipPackages
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}
