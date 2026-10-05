// "This order came from a marketing email." A campaign link lands on the
// storefront with ?er=<recipient id>; we keep it for 14 days (the same window
// the API accepts) so an order placed later in the week is still credited.
// Storage can be blocked (private mode), so every access is guarded — losing
// an attribution must never break ordering.

const KEY = "oh_email_ref";
const TTL_MS = 14 * 86400_000;

export function rememberEmailRef(id: string): void {
  if (!/^[a-z0-9]{10,40}$/i.test(id)) return;
  try {
    window.localStorage.setItem(KEY, JSON.stringify({ id, at: Date.now() }));
  } catch {
    /* storage unavailable */
  }
}

export function readEmailRef(): string | undefined {
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return undefined;
    const v = JSON.parse(raw) as { id?: string; at?: number };
    if (!v?.id || !v.at || Date.now() - v.at > TTL_MS) return undefined;
    return v.id;
  } catch {
    return undefined;
  }
}
