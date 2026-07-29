// Paper chit for an online table booking.
//
// Restaurants that take bookings on paper want the same physical artefact
// they'd write on a pad — the diary on screen is no use to a host standing
// at a door. Printed the moment the booking lands, on the same Bluetooth
// bridge the order tickets use.
//
// Everything printed here is ASCII: thermal printers are CP437, not UTF-8,
// so an em dash or a curly quote comes out as "?".

import {
  hasNativeBridge,
  bridgeSupportsPrinter,
  writeToPrinter,
} from "./bridge";
import { printersClient } from "../api/printers.client";

export interface BookingChit {
  reference: string;
  customerName: string;
  customerPhone?: string | null;
  partySize: number;
  startsAt: string;
  durationMins?: number;
  tableName?: string | null;
  notes?: string | null;
  locationName?: string | null;
}

// ── Minimal ESC/POS ────────────────────────────────────────────────────
const ESC = 0x1b;
const GS = 0x1d;
const LF = 0x0a;
const INIT = [ESC, 0x40];
const ALIGN_CENTER = [ESC, 0x61, 0x01];
const ALIGN_LEFT = [ESC, 0x61, 0x00];
const BOLD_ON = [ESC, 0x45, 0x01];
const BOLD_OFF = [ESC, 0x45, 0x00];
const DOUBLE_ON = [GS, 0x21, 0x11];
const DOUBLE_OFF = [GS, 0x21, 0x00];
const CUT = [GS, 0x56, 0x42, 0x00];

/** CP437 bytes. Anything exotic degrades to "?" rather than corrupting. */
function strBytes(s: string): number[] {
  const out: number[] = [];
  for (const ch of s) {
    const code = ch.charCodeAt(0);
    if (code === 0xa3) out.push(0x9c); // £
    else if (code < 128) out.push(code);
    else out.push(0x3f); // ?
  }
  return out;
}

function line(buf: number[], text = "") {
  buf.push(...strBytes(text), LF);
}

const cols = (paperWidth: number) => (paperWidth === 58 ? 32 : 48);

function whenLabel(iso: string): { date: string; time: string } {
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return { date: "", time: "" };
  return {
    date: d.toLocaleDateString("en-GB", {
      weekday: "short",
      day: "2-digit",
      month: "short",
    }),
    time: d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" }),
  };
}

/** Wrap free text so a long allergy note doesn't run off the paper. */
function wrap(text: string, width: number): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const out: string[] = [];
  let cur = "";
  for (const w of words) {
    if (!cur.length) cur = w;
    else if (cur.length + 1 + w.length <= width) cur += ` ${w}`;
    else {
      out.push(cur);
      cur = w;
    }
  }
  if (cur) out.push(cur);
  return out;
}

export function buildBookingChit(
  b: BookingChit,
  paperWidth = 80,
): Uint8Array {
  const w = cols(paperWidth);
  const { date, time } = whenLabel(b.startsAt);
  const buf: number[] = [];

  buf.push(...INIT, ...ALIGN_CENTER);
  buf.push(...BOLD_ON);
  line(buf, "*** TABLE BOOKING ***");
  buf.push(...BOLD_OFF);
  if (b.locationName) line(buf, b.locationName);
  line(buf, "");

  // The two things a host reads first, at double size.
  buf.push(...DOUBLE_ON, ...BOLD_ON);
  line(buf, time);
  line(buf, `${b.partySize} ${b.partySize === 1 ? "GUEST" : "GUESTS"}`);
  buf.push(...DOUBLE_OFF, ...BOLD_OFF);
  line(buf, date);
  line(buf, "");

  buf.push(...ALIGN_LEFT);
  line(buf, "-".repeat(w));
  buf.push(...BOLD_ON);
  line(buf, b.customerName.toUpperCase());
  buf.push(...BOLD_OFF);
  if (b.customerPhone) line(buf, `Tel: ${b.customerPhone}`);
  line(buf, `Table: ${b.tableName ?? "not assigned yet"}`);
  if (b.durationMins) line(buf, `Held for: ${b.durationMins} mins`);
  line(buf, `Ref: ${b.reference}`);
  line(buf, "-".repeat(w));

  if (b.notes?.trim()) {
    line(buf, "");
    buf.push(...BOLD_ON);
    line(buf, "NOTE:");
    buf.push(...BOLD_OFF);
    for (const l of wrap(b.notes.trim(), w)) line(buf, l);
    line(buf, "-".repeat(w));
  }

  buf.push(...ALIGN_CENTER);
  line(buf, "Booked online");
  buf.push(LF, LF, LF, ...CUT);
  return new Uint8Array(buf);
}

/**
 * Print the chit on every reachable printer at the location. Best-effort
 * by design: a booking must never fail because a printer is asleep, so
 * this resolves quietly and returns how many copies actually landed.
 */
export async function printBookingViaBridge(
  locationId: string,
  booking: BookingChit,
): Promise<number> {
  if (!hasNativeBridge()) return 0;
  const printers = await printersClient.list(locationId);
  const targets = printers.filter(
    (p: any) =>
      p.locationId === locationId &&
      (p.connectionType === "BLUETOOTH" || p.connectionType === "LAN") &&
      p.ipAddress &&
      p.isActive !== false &&
      bridgeSupportsPrinter(p),
  );
  let printed = 0;
  for (const p of targets) {
    try {
      await writeToPrinter(p, buildBookingChit(booking, p.paperWidth ?? 80));
      printed++;
    } catch {
      // One dead printer must not stop the others.
    }
  }
  return printed;
}
