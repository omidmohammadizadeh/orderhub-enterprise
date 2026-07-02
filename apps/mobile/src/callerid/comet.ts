// Phase BB-2 — CTI Comet USB caller-ID reader (Android hub tablet).
//
// The Comet sits on the shop's analogue line and emits the caller's number
// over USB serial when the line rings. This module:
//   1. watches for a USB serial device (poll — tablets get (un)plugged),
//   2. opens it with a BAUD HUNT (Comet firmwares vary: 1200/4800/9600) —
//      a wrong baud yields binary garbage, so we score printable-ASCII
//      ratio and move on until lines look like text,
//   3. logs EVERY raw line (shape-first: we pin the exact firmware format
//      from real output rather than guessing),
//   4. extracts a UK phone number from any line and emits it, deduped.
//
// iOS never runs this (no public USB serial API on iOS) — the hub role is
// Android-only; iPads receive the popup via the socket broadcast instead.

import { Platform } from "react-native";

type OnNumber = (phone: string, rawLine: string) => void;
type OnLog = (msg: string) => void;

const BAUD_CANDIDATES = [1200, 9600, 4800, 2400] as const;
const PROBE_MS = 12_000; // listen this long per baud before moving on
const DEDUPE_MS = 10_000; // Comet repeats the burst on every ring

// Matches 0…/+44… UK numbers inside an arbitrary line once spacing/dashes
// are stripped, e.g. "01/07 22:36 07788180709" or "NBR=+447788180709".
const UK_NUMBER = /(?:\+?44|0)\d{9,10}/;

let stopped = true;

export function stopCometReader() {
  stopped = true;
}

export async function startCometReader(onNumber: OnNumber, onLog: OnLog = () => {}) {
  if (Platform.OS !== "android") return; // hub role is Android-only

  // Lazy import so iOS bundles don't touch the native module at all.
  let UsbSerialManager: any, Parity: any;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mod = require("react-native-usb-serialport-for-android");
    UsbSerialManager = mod.UsbSerialManager;
    Parity = mod.Parity;
  } catch {
    onLog("callerid: usb serial module not present in this build");
    return;
  }

  stopped = false;
  onLog("callerid: watching for USB caller-ID device…");

  while (!stopped) {
    try {
      const devices = await UsbSerialManager.list();
      if (!devices?.length) {
        await sleep(10_000);
        continue;
      }
      const device = devices[0];
      const granted = await UsbSerialManager.tryRequestPermission(device.deviceId);
      if (!granted) {
        onLog("callerid: USB permission denied — will retry");
        await sleep(15_000);
        continue;
      }

      // ── Baud hunt ────────────────────────────────────────────────────
      for (const baud of BAUD_CANDIDATES) {
        if (stopped) return;
        onLog(`callerid: opening ${device.deviceId} @ ${baud} baud`);
        let port: any = null;
        try {
          port = await UsbSerialManager.open(device.deviceId, {
            baudRate: baud,
            parity: Parity.None,
            dataBits: 8,
            stopBits: 1,
          });
        } catch (e: any) {
          onLog(`callerid: open failed @ ${baud}: ${e?.message}`);
          continue;
        }

        const result = await listenOnPort(port, baud, onNumber, onLog);
        try {
          port.close();
        } catch {
          /* already gone */
        }
        if (result === "unplugged") break; // back to device polling
        if (result === "locked") {
          // Right baud found — listenOnPort only returns "locked" when the
          // port later errored/closed; reopen at the same baud next loop.
          break;
        }
        // "garbage" → try the next baud candidate
      }
    } catch (e: any) {
      onLog(`callerid: reader error: ${e?.message}`);
    }
    await sleep(5_000);
  }
}

/**
 * Listen on an open port. Returns:
 *  - "garbage"   — data ratio says wrong baud, try the next one
 *  - "locked"    — real text was seen (right baud) but the port ended
 *  - "unplugged" — no device anymore
 */
function listenOnPort(
  port: any,
  baud: number,
  onNumber: OnNumber,
  onLog: OnLog,
): Promise<"garbage" | "locked" | "unplugged"> {
  return new Promise((resolve) => {
    let buffer = "";
    let printable = 0;
    let total = 0;
    let locked = false;
    const lastSeen = new Map<string, number>();

    const probeTimer = setTimeout(() => {
      if (locked) return; // saw good text — keep listening indefinitely
      const ratio = total === 0 ? 1 : printable / total;
      if (total > 0 && ratio < 0.7) {
        onLog(`callerid: ${baud} baud looks wrong (ascii ${(ratio * 100) | 0}%) — hunting on`);
        cleanup();
        resolve("garbage");
      }
      // total === 0 → line just hasn't rung yet; stay on this baud.
    }, PROBE_MS);

    const sub = port.onReceived((event: any) => {
      // Library delivers hex-encoded bytes.
      const bytes = hexToBytes(event.data ?? "");
      for (const b of bytes) {
        total++;
        const ch = String.fromCharCode(b);
        const isPrintable = (b >= 0x20 && b < 0x7f) || b === 0x0a || b === 0x0d;
        if (isPrintable) printable++;
        if (b === 0x0a || b === 0x0d) {
          const line = buffer.trim();
          buffer = "";
          if (!line) continue;
          locked = true;
          // SHAPE-FIRST: always log the raw line so we can pin the exact
          // firmware format from production output.
          onLog(`callerid RAW @${baud}: ${JSON.stringify(line)}`);
          const m = line.replace(/[\s-]/g, "").match(UK_NUMBER);
          if (m) {
            const phone = m[0];
            const now = Date.now();
            if (now - (lastSeen.get(phone) ?? 0) > DEDUPE_MS) {
              lastSeen.set(phone, now);
              onNumber(phone, line);
            }
          }
        } else if (isPrintable) {
          buffer += ch;
          if (buffer.length > 200) buffer = buffer.slice(-200);
        }
      }
    });

    const cleanup = () => {
      clearTimeout(probeTimer);
      try {
        sub?.remove?.();
      } catch {
        /* noop */
      }
    };

    // The lib surfaces disconnects as an error/close on read; poll the
    // device list as a fallback so unplugging doesn't strand us.
    const alive = setInterval(async () => {
      if (stopped) {
        clearInterval(alive);
        cleanup();
        resolve(locked ? "locked" : "garbage");
      }
    }, 2_000);
  });
}

function hexToBytes(hex: string): number[] {
  const out: number[] = [];
  for (let i = 0; i + 1 < hex.length; i += 2) {
    const n = parseInt(hex.slice(i, i + 2), 16);
    if (!Number.isNaN(n)) out.push(n);
  }
  return out;
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}
