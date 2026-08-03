// CTI Comet USB caller-ID reader (Android hub tablet).
//
// Crucible Technologies' Comet sits on the shop's analogue line and presents
// the caller's number on a virtual COM port over USB.
//
// Written against the manufacturer's own spec (CTI Comet USB User and
// Developer Guide), not guesswork. Two facts from it drive everything here:
//
//   1. 1200 baud, 1 start bit, 1 stop bit. Fixed. There is nothing to hunt.
//   2. The device does NOT emit text lines. It emits raw binary Caller ID
//      frames — Multiple Data Message Format, the European/UK standard:
//
//        <type> <length> [<param type> <param len> <param data>]... <checksum>
//
//      Type 0x80 is a valid caller ID, 0x82 message-waiting. Inside, the
//      parameter we want is 0x02, the calling number, in ASCII.
//
// The first version assumed CR/LF-terminated text and scored "printable ASCII
// ratio" to detect a wrong baud rate. Against binary frames that is wrong
// twice over: a perfectly valid frame scores as garbage, and with no
// terminator it never assembles a line to act on. A caller-ID frame is also
// only ~25 bytes — under the 40-byte threshold that triggered any judgement
// at all — so real frames could arrive and vanish without leaving a trace.
//
// iOS never runs this (no public USB serial API) — the hub role is
// Android-only; iPads receive the popup via the socket broadcast instead.

import { Platform } from "react-native";

type OnNumber = (phone: string, rawLine: string) => void;
type OnLog = (msg: string) => void;

/** Documented by the manufacturer. Not a guess, and not negotiable. */
const BAUD = 1200;

/** The Comet repeats its burst on every ring of the same call. */
const DEDUPE_MS = 10_000;

/** Message types. */
const MSG_MDMF_CALLERID = 0x80;
const MSG_MDMF_MSG_WAITING = 0x82;
const MSG_SDMF_CALLERID = 0x04;

/** MDMF parameter types we care about. */
const PARAM_NUMBER = 0x02;
const PARAM_NAME = 0x07;

/** Type + length + body + checksum, and the body is bounded by a single
 *  length byte, so nothing here can grow without limit. */
const MAX_FRAME = 260;

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
      // Vendor/product ID identify the chipset, and the chipset decides
      // whether a driver exists at all. The Comet is FTDI silicon (0x0403)
      // with a custom product ID (0x8e08) burned into its EEPROM, which the
      // stock probe table doesn't know — hence the patch in patches/.
      const vid = device?.vendorId;
      const pid = device?.productId;
      const idHex = (n: unknown) =>
        typeof n === "number" ? `0x${n.toString(16).padStart(4, "0")}` : "?";
      onLog(
        `callerid: device ${device.deviceId} vendorId=${idHex(vid)} (${vid}) productId=${idHex(pid)} (${pid})`,
      );

      const granted = await UsbSerialManager.tryRequestPermission(device.deviceId);
      if (!granted) {
        onLog("callerid: USB permission denied — will retry");
        await sleep(15_000);
        continue;
      }

      onLog(`callerid: opening ${device.deviceId} @ ${BAUD} baud (8N1)`);
      let port: any = null;
      try {
        port = await UsbSerialManager.open(device.deviceId, {
          baudRate: BAUD,
          parity: Parity.None,
          dataBits: 8,
          stopBits: 1,
        });
      } catch (e: any) {
        const msg = String(e?.message ?? e);
        onLog(`callerid: open failed: ${msg}`);
        if (/no driver/i.test(msg)) {
          onLog("callerid: this box's USB chipset has no serial driver in this build");
        }
        await sleep(10_000);
        continue;
      }

      onLog("callerid: listening for caller-ID frames");
      const result = await listenOnPort(
        port,
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
      if (result === "unplugged") onLog("callerid: device gone — re-acquiring");
    } catch (e: any) {
      onLog(`callerid: reader error: ${e?.message}`);
    }
    await sleep(5_000);
  }
}

/**
 * Listen on an open port, decoding MDMF/SDMF caller-ID frames.
 *
 * There is no "wrong baud" outcome any more — the rate is documented, so a
 * failure to decode is a failure to decode, and the raw hex is logged so it
 * can be diagnosed rather than guessed at.
 */
function listenOnPort(
  port: any,
  onNumber: OnNumber,
  onLog: OnLog,
  listDevices: () => Promise<any[]>,
  deviceId: any,
): Promise<"unplugged" | "stopped"> {
  return new Promise((resolve) => {
    let buf: number[] = [];
    let settled = false;
    let announced = false;
    const lastSeen = new Map<string, number>();

    const settle = (result: "unplugged" | "stopped") => {
      if (settled) return;
      settled = true;
      clearInterval(alive);
      try {
        sub?.remove?.();
      } catch {
        /* noop */
      }
      resolve(result);
    };

    /** Pull every complete frame out of the buffer, discarding junk ahead of
     *  a recognised message type. */
    const drainFrames = () => {
      for (;;) {
        const start = buf.findIndex(
          (b) =>
            b === MSG_MDMF_CALLERID ||
            b === MSG_MDMF_MSG_WAITING ||
            b === MSG_SDMF_CALLERID,
        );
        if (start < 0) {
          // Nothing usable — keep a small tail in case a type byte arrives
          // split across reads.
          if (buf.length > 8) buf = buf.slice(-8);
          return;
        }
        if (start > 0) buf = buf.slice(start);
        if (buf.length < 2) return; // need the length byte

        const type = buf[0]!;
        const len = buf[1]!;
        const total = len + 3; // type + length + body + checksum
        if (total > MAX_FRAME) {
          buf = buf.slice(1); // not a real frame — rescan from the next byte
          continue;
        }
        if (buf.length < total) return; // wait for the rest

        const frame = buf.slice(0, total);
        buf = buf.slice(total);
        handleFrame(type, frame);
      }
    };

    const handleFrame = (type: number, frame: number[]) => {
      // SHAPE-FIRST: log every frame as hex. The spec gives us the structure;
      // production tells us what this particular unit actually sends.
      onLog(`callerid FRAME type=0x${type.toString(16)} ${describe(frame)}`);

      if (!checksumOk(frame)) {
        onLog("callerid: frame checksum mismatch — ignoring");
        return;
      }

      const phone =
        type === MSG_SDMF_CALLERID
          ? sdmfNumber(frame)
          : mdmfParam(frame, PARAM_NUMBER);
      const name =
        type === MSG_SDMF_CALLERID ? null : mdmfParam(frame, PARAM_NAME);

      if (!phone) {
        // A valid frame with no number: withheld, unavailable, or a
        // message-waiting notice. Say which, rather than looking broken.
        onLog(
          type === MSG_MDMF_MSG_WAITING
            ? "callerid: message-waiting frame (no caller)"
            : "callerid: frame carried no calling number (withheld or unavailable)",
        );
        return;
      }

      const digits = phone.replace(/[^\d+]/g, "");
      if (!digits) return;
      const now = Date.now();
      if (now - (lastSeen.get(digits) ?? 0) < DEDUPE_MS) return;
      lastSeen.set(digits, now);
      onNumber(digits, name ? `${digits} (${name})` : digits);
    };

    const sub = port.onReceived((event: any) => {
      const bytes = hexToBytes(event.data ?? "");
      if (!bytes.length) return;

      // Announce the first bytes of a session whatever they look like. Every
      // other log here needs a complete, valid frame — so without this, a box
      // sending something we can't decode is indistinguishable from a line
      // carrying no caller ID at all. Opposite problems, opposite fixes.
      if (!announced) {
        announced = true;
        onLog(`callerid: FIRST DATA — ${describe(bytes)}`);
      }

      buf.push(...bytes);
      if (buf.length > MAX_FRAME * 4) buf = buf.slice(-MAX_FRAME * 2);
      drainFrames();
    });

    // Unplug watchdog. Polls the device list so the outer loop gets control
    // back and can re-acquire the box on its own; without it, pulling the
    // Comet stranded the reader on a dead port until the app restarted.
    const alive = setInterval(async () => {
      if (stopped) {
        settle("stopped");
        return;
      }
      try {
        const devices = await listDevices();
        const stillThere = (devices ?? []).some(
          (d: any) => d?.deviceId === deviceId,
        );
        if (!stillThere) settle("unplugged");
      } catch {
        /* transient list failure — try again next tick */
      }
    }, 5_000);
  });
}

/** MDMF: walk the parameter list and return one parameter as text. */
export function mdmfParam(frame: number[], wanted: number): string | null {
  // frame[0] = type, frame[1] = length, body starts at 2, last byte = checksum
  let i = 2;
  const end = frame.length - 1;
  while (i + 1 < end) {
    const ptype = frame[i]!;
    const plen = frame[i + 1]!;
    const start = i + 2;
    if (start + plen > end) return null; // truncated — don't invent data
    if (ptype === wanted) {
      return String.fromCharCode(...frame.slice(start, start + plen)).trim();
    }
    i = start + plen;
  }
  return null;
}

/** SDMF has no parameter list: MMDDHHMM then the number, all ASCII. */
export function sdmfNumber(frame: number[]): string | null {
  const body = frame.slice(2, frame.length - 1);
  const text = String.fromCharCode(...body);
  const rest = text.slice(8).trim();
  return rest || null;
}

/** The checksum is the two's complement of the sum of every preceding byte,
 *  so the whole frame including it sums to zero modulo 256. */
export function checksumOk(frame: number[]): boolean {
  if (frame.length < 3) return false;
  let sum = 0;
  for (let i = 0; i < frame.length - 1; i++) sum += frame[i]!;
  return ((sum + frame[frame.length - 1]!) & 0xff) === 0;
}

/** Hex + printable ASCII, for logs that have to survive being photographed. */
function describe(bytes: number[]): string {
  const slice = bytes.slice(0, 40);
  const hex = slice.map((b) => b.toString(16).padStart(2, "0")).join(" ");
  const ascii = slice
    .map((b) => (b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : "."))
    .join("");
  return `${bytes.length}B hex=[${hex}] ascii="${ascii}"`;
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
