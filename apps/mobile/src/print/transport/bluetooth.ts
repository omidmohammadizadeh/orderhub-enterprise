// Bluetooth Classic transport for ESC/POS receipt printers.
//
// Why bluetooth-classic and not BLE: Epson TM-m30II, Star portable
// printers, MUNBYN, and most "60mm/80mm thermal" printers expose
// themselves as Bluetooth Classic SPP (Serial Port Profile) — a
// raw byte stream over RFCOMM. BLE is for low-power sensors,
// not high-throughput receipt printers.
//
// User must pair the printer in Android Settings first. We don't
// implement in-app pairing for v1 — bonding has many edge cases
// (PIN entry, encryption negotiation, missed passkey dialogs) and
// the Android system flow handles all of them already.

import {
  PermissionsAndroid,
  Platform,
  type Permission,
} from "react-native";
import RNBluetoothClassic, {
  type BluetoothDevice,
} from "react-native-bluetooth-classic";

// Bytes per chunk on Bluetooth write. RFCOMM negotiates MTU but
// most ESC/POS printers (Epson included) crash if a single write
// is too large. 512 is conservative and never given me trouble
// across vendors.
const CHUNK_SIZE = 512;

// Pause between chunks. The printer's internal buffer is small
// (4KB on the TM-m30II per the self-test). Without backpressure we
// can overflow it during long receipts; a tiny delay between
// chunks lets the printer drain.
const CHUNK_PAUSE_MS = 30;

export interface PairedBtDevice {
  address: string; // MAC, e.g. "00:01:90:42:EE:C9"
  name: string;
}

/** Ask the user for the Android 12+ Bluetooth runtime permissions.
 *  Returns true if every required permission was granted.
 *  No-op on iOS (BT permissions are declared statically in Info.plist). */
export async function ensureBtPermissions(): Promise<boolean> {
  if (Platform.OS !== "android") return true;

  // Android 12 (API 31) introduced BLUETOOTH_SCAN / BLUETOOTH_CONNECT.
  // Older Android uses BLUETOOTH + BLUETOOTH_ADMIN + ACCESS_FINE_LOCATION,
  // which the system grants at install time. So we only need to ask
  // for the runtime perms when we're on 31+.
  if (Platform.Version < 31) return true;

  const wanted: Permission[] = [
    "android.permission.BLUETOOTH_SCAN" as Permission,
    "android.permission.BLUETOOTH_CONNECT" as Permission,
  ];

  const result = await PermissionsAndroid.requestMultiple(wanted);
  return wanted.every(
    (p) => result[p] === PermissionsAndroid.RESULTS.GRANTED,
  );
}

/** True if Bluetooth is currently switched on at the OS level. */
export async function isBtEnabled(): Promise<boolean> {
  try {
    return await RNBluetoothClassic.isBluetoothEnabled();
  } catch {
    return false;
  }
}

/** Devices the user has already paired in Android Settings. We don't
 *  scan for unpaired devices — pairing happens in the system UI to
 *  avoid handling PIN/passkey ourselves. */
export async function listBondedDevices(): Promise<PairedBtDevice[]> {
  const ok = await ensureBtPermissions();
  if (!ok) {
    throw new Error(
      "Bluetooth permissions denied. Enable them in Settings → Apps → Order Hub Solutions → Permissions.",
    );
  }
  const devices = await RNBluetoothClassic.getBondedDevices();
  return devices.map((d) => ({ address: d.address, name: d.name }));
}

/** Connect to a bonded device, write the buffer in chunks, close.
 *  Throws on any I/O failure so the caller can surface a clear error. */
export async function sendBytesOverBt(
  address: string,
  bytes: Uint8Array,
): Promise<void> {
  const ok = await ensureBtPermissions();
  if (!ok) throw new Error("Bluetooth permissions not granted");

  let device: BluetoothDevice | null = null;
  try {
    device = await RNBluetoothClassic.connectToDevice(address, {
      // Standard SPP UUID for ESC/POS printers
      CONNECTOR_TYPE: "rfcomm",
      DELIMITER: "",
      DEVICE_CHARSET: "utf-8",
    });

    // Stream chunks with a small pause between to respect the
    // printer's input buffer.
    //
    // CRITICAL: pass "base64" as the encoding hint so the lib decodes
    // the base64 string back into raw bytes BEFORE writing to RFCOMM.
    // Without this hint, write() sends the ASCII bytes of the base64
    // string itself, and the printer prints "G0AbYQE=…" instead of
    // honouring the ESC/POS commands.
    for (let i = 0; i < bytes.length; i += CHUNK_SIZE) {
      const chunk = bytes.subarray(i, i + CHUNK_SIZE);
      await device.write(toBase64(chunk), "base64");
      if (i + CHUNK_SIZE < bytes.length) {
        await new Promise((r) => setTimeout(r, CHUNK_PAUSE_MS));
      }
    }
  } finally {
    try {
      if (device) await device.disconnect();
    } catch {
      // disconnect errors are non-fatal — the printer will time out
      // its own side of the connection in a few seconds.
    }
  }
}

// React Native doesn't ship a built-in Buffer; small base64 helper
// for the BT write path. Handles arbitrary binary cleanly (no
// UTF-8 boundary issues — every byte gets its own slot).
function toBase64(bytes: Uint8Array): string {
  const chars =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  let out = "";
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const a = bytes[i],
      b = bytes[i + 1],
      c = bytes[i + 2];
    out += chars[a >> 2];
    out += chars[((a & 3) << 4) | (b >> 4)];
    out += chars[((b & 15) << 2) | (c >> 6)];
    out += chars[c & 63];
  }
  if (i < bytes.length) {
    const a = bytes[i];
    const b = i + 1 < bytes.length ? bytes[i + 1] : 0;
    out += chars[a >> 2];
    out += chars[((a & 3) << 4) | (b >> 4)];
    if (i + 1 < bytes.length) {
      out += chars[(b & 15) << 2];
      out += "=";
    } else {
      out += "==";
    }
  }
  return out;
}
