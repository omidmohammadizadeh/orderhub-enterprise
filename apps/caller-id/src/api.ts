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
export function normalisePhone(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const cleaned = String(raw).replace(/[\s\-()]/g, "");
  const m = cleaned.match(/\+?\d{7,15}/);
  return m ? m[0] : null;
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
