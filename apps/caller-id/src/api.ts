import AsyncStorage from "@react-native-async-storage/async-storage";
import { CallerIdConfig } from "./config";

// Recency dedup, shared across the foreground SIM path and the background VoIP
// headless task (hence AsyncStorage, not memory). A real ring lasts far longer
// than this window, so suppressing the same number for a few seconds only ever
// swallows duplicates — Android re-delivering a notification, or a listener
// reconnect replaying it — never a genuine second call.
const DEDUP_KEY = "orderhub.callerid.lastring";
const DEDUP_WINDOW_MS = 15_000;

async function seenRecently(num: string): Promise<boolean> {
  try {
    const now = Date.now();
    const raw = await AsyncStorage.getItem(DEDUP_KEY);
    const map = raw ? (JSON.parse(raw) as Record<string, number>) : {};
    if (now - (map[num] ?? 0) < DEDUP_WINDOW_MS) return true;
    // Record this ring + prune anything older than a minute so the map stays small.
    const next: Record<string, number> = { [num]: now };
    for (const [k, v] of Object.entries(map)) {
      if (k !== num && now - v < 60_000) next[k] = v;
    }
    await AsyncStorage.setItem(DEDUP_KEY, JSON.stringify(next));
    return false;
  } catch {
    return false; // never block a ring on a storage hiccup
  }
}

// A UK-friendly number sniff: keep a leading +, strip spacing/dashes/parens,
// accept 7–15 digits. Mirrors the server's extractVoipPhone() so anything we
// send is something it will accept.
//
// The subtlety that bit us: this used to strip separators from the WHOLE
// string first and then take the first 7–15 digit run. A bOnline notification
// carries the caller's number twice — once in the title, once in the text —
// so once the space between them was gone the run read as one 22-digit
// number, and the 15-digit cap sliced it into 074384673800743. The till
// showed staff a number that does not exist.
//
// Now: find number-SHAPED runs with their separators intact, so the boundary
// between two numbers survives, and REJECT a run that is too long instead of
// truncating it. Truncating invents a number; rejecting means no ring, and
// the caller reads the title first anyway, where the real number is.
const MAX_DIGITS = 15;
const MIN_DIGITS = 7;

export function normalisePhone(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const text = String(raw);
  // Number-SHAPED runs, separators intact, so the gap between two numbers is
  // still visible when we come to split them.
  const runs = text.match(/\+?\d[\d\s\-()]*\d|\+?\d/g) ?? [];

  for (const run of runs) {
    // A run can be one number written with spaces ("07438 467380",
    // "(0113) 496 0000") or two numbers side by side. Both look identical
    // until you count digits, so take the LONGEST run of whole space-
    // separated pieces that still fits a phone number, and stop before the
    // piece that would push it over. That keeps a spaced number intact and
    // cuts a doubled one at the join.
    const pieces = run.split(/\s+/).filter(Boolean);
    let acc = "";
    for (const piece of pieces) {
      const next = acc + piece.replace(/[-()]/g, "");
      const bare = next.startsWith("+") ? next.slice(1) : next;
      if (bare.length > MAX_DIGITS) break;
      acc = next;
    }
    const bare = acc.startsWith("+") ? acc.slice(1) : acc;
    if (bare.length >= MIN_DIGITS) return acc;
  }
  return null;
}

/**
 * Push a caught caller number to OrderHub. Reuses the PUBLIC VoIP caller-ID
 * webhook (POST /v1/customers/caller-id/voip/:locationId?key=…) which already
 * accepts a bare { phone } body and broadcasts the popup to the shop's POS
 * tablets — so no backend change is needed.
 *
 * Returns a short status string for the on-screen log. Never throws.
 */
export async function postRing(
  c: CallerIdConfig,
  phone: string,
  source: "SIM" | "VOIP",
): Promise<{ ok: boolean; detail: string }> {
  const num = normalisePhone(phone);
  if (!num) return { ok: false, detail: "no number" };
  if (!c.apiBase || !c.locationId || !c.key) {
    return { ok: false, detail: "not configured" };
  }
  if (await seenRecently(num)) return { ok: false, detail: "duplicate (ignored)" };
  const url =
    `${c.apiBase.replace(/\/+$/, "")}` +
    `/api/v1/customers/caller-id/voip/${encodeURIComponent(c.locationId)}` +
    `?key=${encodeURIComponent(c.key)}`;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ phone: num, source }),
    });
    if (res.ok) return { ok: true, detail: `sent (${source})` };
    const text = await res.text();
    return { ok: false, detail: `HTTP ${res.status} ${text.slice(0, 80)}` };
  } catch (e: any) {
    return { ok: false, detail: String(e?.message ?? e).slice(0, 80) };
  }
}
