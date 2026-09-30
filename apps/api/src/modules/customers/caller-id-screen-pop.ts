/**
 * The page a desktop phone client opens when the shop's phone rings.
 *
 * 8x8 Work's "Caller info popup" takes a web address, substitutes the caller's
 * number into it and OPENS it in a browser. So on every call somebody at the
 * shop's PC gets a tab whether they want one or not — which makes this page
 * the one part of the caller-ID system a human is guaranteed to look at.
 *
 * It therefore says the two things that matter in the two seconds it is on
 * screen: who is calling, and whether the tills already know. Everything is
 * inline — no fonts, no scripts from anywhere, no network of its own — because
 * it renders on a shop PC on a slow line while a phone is ringing.
 */

export type ScreenPopResult =
  | {
      ok: true;
      phone: string;
      match: { name?: string | null; orders?: number } | null;
    }
  | { ok: false; reason: "bad key" | "no caller number" | "unknown location" };

/**
 * A macro the phone client never filled in, e.g. a literal "%%CallerNumber%%".
 *
 * Returned so the failure can name itself. Someone reading "no caller number"
 * checks their call flow; someone reading "%%CallerNumber%%" knows instantly
 * that the URL was pasted into the wrong box, or that their client spells the
 * macro differently.
 */
export function unsubstitutedMacro(payload: Record<string, unknown>): string | null {
  for (const value of Object.values(payload ?? {})) {
    if (typeof value === "string" && /%%.*%%|%[A-Za-z]+%|\{\{.*\}\}/.test(value)) {
      return value.slice(0, 40);
    }
  }
  return null;
}

const PAGE = (title: string, body: string, tone: "good" | "bad") => `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
  :root { color-scheme: light dark; }
  body { margin:0; min-height:100vh; display:flex; align-items:center;
         justify-content:center; font:16px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;
         background:#f4f4f5; color:#18181b; }
  .card { width:min(420px,calc(100vw - 2rem)); background:#fff; border-radius:14px;
          border:1px solid ${tone === "good" ? "#a7f3d0" : "#fecaca"};
          box-shadow:0 10px 30px rgba(0,0,0,.08); overflow:hidden; }
  .bar { background:${tone === "good" ? "#059669" : "#dc2626"}; color:#fff;
         padding:10px 16px; font-weight:700; font-size:14px; }
  .body { padding:16px; }
  .num { font-size:26px; font-weight:700; letter-spacing:.5px; margin:0 0 4px; }
  .who { font-size:15px; margin:0 0 10px; }
  .note { font-size:13px; color:#52525b; margin:0; }
  @media (prefers-color-scheme: dark) {
    body { background:#18181b; color:#fafafa; }
    .card { background:#27272a; border-color:#3f3f46; }
    .note { color:#a1a1aa; }
  }
</style></head>
<body><div class="card">
  <div class="bar">${escapeHtml(title)}</div>
  <div class="body">${body}</div>
</div></body></html>`;

export function screenPopPage(result: ScreenPopResult): string {
  if (!result.ok) {
    const why: Record<string, string> = {
      "bad key":
        "The key in this address is wrong or missing. Copy it again from Caller ID → Phone provider in the dashboard.",
      "no caller number":
        "The phone system opened this page but sent no caller number. Check the address in the caller-popup setting still ends with the caller-number macro.",
      "unknown location":
        "This address points at a shop that no longer exists. Copy a fresh one from Caller ID → Phone provider.",
    };
    return PAGE(
      "Not sent to the tills",
      `<p class="note">${escapeHtml(why[result.reason] ?? "The ring didn't reach the tills.")}</p>`,
      "bad",
    );
  }

  const name = result.match?.name?.trim();
  const orders = result.match?.orders ?? 0;
  const who = name
    ? `<p class="who"><strong>${escapeHtml(name)}</strong>${
        orders > 0 ? ` · ${orders} previous order${orders === 1 ? "" : "s"}` : ""
      }</p>`
    : `<p class="who">New caller — no order history.</p>`;

  return PAGE(
    "Caller sent to the tills",
    `<p class="num">${escapeHtml(result.phone)}</p>
     ${who}
     <p class="note">Their card is on every till in the shop. You can close this tab.</p>`,
    "good",
  );
}

/** The caller's number is theirs, not ours — it never goes in unescaped. */
function escapeHtml(value: string): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
