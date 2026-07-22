import { CallerIdConfig } from "./config";

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
