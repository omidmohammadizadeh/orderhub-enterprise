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
// How many bytes to collect before judging whether a baud is wrong. Small
// enough that one ring's burst is a verdict, big enough that a couple of
// stray bytes on an idle line don't trigger a pointless re-hunt.
const GARBAGE_SAMPLE_BYTES = 40;
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

        const result = await listenOnPort(
          port,
          baud,
          onNumber,
          onLog,
          () => UsbSerialManager.list(),
          device.deviceId,
        );
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
  listDevices: () => Promise<any[]>,
  deviceId: any,
): Promise<"garbage" | "locked" | "unplugged"> {
  return new Promise((resolve) => {
    let buffer = "";
    let printable = 0;
    let total = 0;
    let locked = false;
    let settled = false;
    const lastSeen = new Map<string, number>();

    const settle = (result: "garbage" | "locked" | "unplugged") => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(result);
    };

    // Wrong-baud detection is DATA-driven, not time-driven.
    //
    // This used to be a one-shot 12s timer: if the line happened to be quiet
    // during those 12 seconds (the normal case — a shop's phone is not
    // ringing when the tablet boots) the timer fired, found total === 0, and
    // deliberately stayed on the current baud. The timer never ran again, so
    // when a call finally arrived at a DIFFERENT baud the incoming garbage
    // could no longer trigger the hunt. The reader sat on 1200 forever and
    // silently never produced a number.
    //
    // Now we judge whenever enough bytes have actually arrived, no matter how
    // long the line stayed quiet first. Silence still costs nothing — we
    // simply don't decide until there is something to decide on.
    const judge = () => {
      if (locked || settled) return;
      if (total < GARBAGE_SAMPLE_BYTES) return;
      const ratio = printable / total;
      if (ratio < 0.7) {
        onLog(
          `callerid: ${baud} baud looks wrong (ascii ${(ratio * 100) | 0}% of ${total}B) — hunting on`,
        );
        settle("garbage");
      } else {
        // Mostly printable but no complete line yet — keep listening; a
        // terminator will arrive and lock us in.
        total = 0;
        printable = 0;
      }
    };

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
      judge();
    });

    const cleanup = () => {
      clearInterval(alive);
      try {
        sub?.remove?.();
      } catch {
        /* noop */
      }
    };

    // Unplug watchdog. This previously only checked `stopped`, so it never
    // actually returned "unplugged" — pulling the Comet out (or a USB reset)
    // stranded the reader on a dead port until the whole app was restarted.
    // Poll the device list so the outer loop gets control back and can
    // re-acquire the box on its own.
    const alive = setInterval(async () => {
      if (stopped) {
        settle(locked ? "locked" : "garbage");
        return;
      }
      try {
        const devices = await listDevices();
        const stillThere = (devices ?? []).some(
          (d: any) => d?.deviceId === deviceId,
        );
        if (!stillThere) {
          onLog("callerid: USB device disappeared — re-acquiring");
          settle("unplugged");
        }
      } catch {
        /* transient list failure — try again next tick */
      }
    }, 5_000);
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
