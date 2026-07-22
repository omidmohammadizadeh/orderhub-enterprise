import { PermissionsAndroid, Platform } from "react-native";
import { loadConfig, voipPackageList } from "./config";
import { normalisePhone, postRing } from "./api";

// ── 1) Native SIM incoming calls (the "divert your number to this phone" path) ──
// Fires when the phone itself rings (a call diverted to this SIM, or this phone
// IS the shop line). Uses react-native-call-detection (PhoneStateListener under
// the hood). Needs READ_PHONE_STATE + READ_CALL_LOG to read the number on
// Android 9+. Only works while the app process is alive (foreground service
// keeps it alive — see the notification the app shows while listening).
let callDetector: any = null;

export async function startCallDetection(
  onIncoming: (phone: string) => void,
  onLog: (msg: string) => void,
): Promise<void> {
  if (Platform.OS !== "android") {
    onLog("SIM detection is Android-only");
    return;
  }
  try {
    // CRITICAL: grant READ_PHONE_STATE (+ READ_CALL_LOG for the number) and WAIT
    // for it BEFORE starting the listener. The library calls
    // telephonyManager.listen() synchronously; on Android 12+/MIUI that throws a
    // native SecurityException — which crashes the app (JS try/catch can't catch
    // a native crash) — when the permission isn't already granted. Pre-granting
    // is the only reliable prevention.
    const res = await PermissionsAndroid.requestMultiple([
      PermissionsAndroid.PERMISSIONS.READ_PHONE_STATE,
      PermissionsAndroid.PERMISSIONS.READ_CALL_LOG,
    ]);
    if (res["android.permission.READ_PHONE_STATE"] !== PermissionsAndroid.RESULTS.GRANTED) {
      onLog("SIM: phone permission not granted — enable it in App info › Permissions");
      return;
    }

    // Dual export (`export default module.exports = …`) → `.default` is undefined,
    // so fall back to the module, which IS the class.
    const mod = require("react-native-call-detection");
    const CallDetectorManager = mod.default || mod;
    // readPhoneNumberAndroid=false: WE just granted the permissions, so we skip
    // the library's own un-awaited request (that race was the crash). The native
    // listener still delivers the incoming number.
    callDetector = new CallDetectorManager(
      (event: string, phoneNumber?: string) => {
        if (event === "Incoming") {
          const n = normalisePhone(phoneNumber);
          onLog(`SIM ring: ${phoneNumber ?? "(no number)"}`);
          if (n) onIncoming(n);
        }
      },
      false,
      () => onLog("SIM: permission denied"),
      {
        title: "Phone access",
        message: "Order Hub Caller ID needs to read incoming calls.",
      },
    );
    onLog("SIM call detection started");
  } catch (e: any) {
    onLog(`SIM detection unavailable: ${e?.message ?? e}`);
  }
}

export function stopCallDetection(): void {
  try {
    callDetector?.dispose?.();
  } catch {
    /* ignore */
  }
  callDetector = null;
}

// ── 2) VoIP app calls (read the VoIP dialer's incoming-call notification) ──────
// Android sandboxes VoIP apps, so we can't read their calls directly — but we
// CAN read the notification they post ("Incoming call from +44…") if the user
// grants Notification Access. We watch only the packages listed in config
// (voipPackages) and pull a number out of the notification text.
export async function getNotifPermission(): Promise<string> {
  try {
    const mod = require("react-native-android-notification-listener").default;
    return await mod.getPermissionStatus(); // 'authorized' | 'denied' | 'unknown'
  } catch {
    return "unknown";
  }
}

export function openNotifPermission(): void {
  try {
    const mod = require("react-native-android-notification-listener").default;
    mod.requestPermission(); // opens the system Notification Access screen
  } catch {
    /* ignore */
  }
}

/**
 * Background headless task — registered in index.js under the name the library
 * dispatches ("RNAndroidNotificationListenerHeadlessJs"). Runs even when the UI
 * is closed. Reads config from AsyncStorage, filters to the watched VoIP apps,
 * sniffs a phone number out of the notification, and posts the ring.
 */
export const headlessNotificationTask = async (taskData: any): Promise<void> => {
  try {
    const notif =
      typeof taskData?.notification === "string"
        ? JSON.parse(taskData.notification)
        : (taskData?.notification ?? taskData ?? {});
    const app = String(notif.app ?? "").toLowerCase();
    const c = await loadConfig();
    const pkgs = voipPackageList(c);
    // If the operator listed specific VoIP apps, only watch those. If they left
    // it blank, watch everything (useful while discovering the right package).
    if (pkgs.length && !pkgs.includes(app)) return;
    const hay = [notif.title, notif.text, notif.bigText, notif.subText, notif.summaryText]
      .filter(Boolean)
      .join(" ");
    const phone = normalisePhone(hay);
    if (!phone) return;
    await postRing(c, phone, "VOIP");
  } catch {
    /* headless tasks must never throw */
  }
};
