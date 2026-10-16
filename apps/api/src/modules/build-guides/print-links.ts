import { createHmac, timingSafeEqual } from "crypto";

// Signed links for the A4 print pages (assembly boards, build guides, menu
// presentations) that open WITHOUT a login.
//
// Why: in the tablet app a "Download PDF" link leaves the WebView for the
// phone's own browser (Chrome / Safari), where nobody is signed in — the page
// 401'd and bounced staff to /login, while the same click on a desktop, in the
// signed-in browser, worked. The signed-in tab mints one of these instead and
// hands the browser a URL that carries it.
//
// A token reads exactly one thing (kind + id) inside one tenant, and expires.

export const PRINT_LINK_KINDS = ["charts-menu", "charts-item", "guides-menu", "guides-item", "presentation"] as const;
export type PrintLinkKind = (typeof PRINT_LINK_KINDS)[number];

export const PRINT_LINK_TTL_SECONDS = 6 * 60 * 60;

export type PrintLinkClaims = { kind: PrintLinkKind; id: string; tenantId: string; exp: number };

function b64url(s: string | Buffer): string {
  return Buffer.from(s).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function sign(secret: string, payload: string): string {
  return b64url(createHmac("sha256", secret).update(`print-link:${payload}`).digest());
}

export function isPrintLinkKind(v: unknown): v is PrintLinkKind {
  return typeof v === "string" && (PRINT_LINK_KINDS as readonly string[]).includes(v);
}

export function makePrintToken(
  secret: string,
  claims: Omit<PrintLinkClaims, "exp">,
  nowSeconds = Math.floor(Date.now() / 1000),
): string {
  const payload = JSON.stringify({ ...claims, exp: nowSeconds + PRINT_LINK_TTL_SECONDS });
  return `${b64url(payload)}.${sign(secret, payload)}`;
}

export function readPrintToken(
  secret: string,
  token: string | undefined | null,
  nowSeconds = Math.floor(Date.now() / 1000),
): PrintLinkClaims | null {
  const [p, sig] = String(token ?? "").split(".");
  if (!p || !sig || !secret) return null;
  const payload = Buffer.from(p.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
  const a = Buffer.from(sign(secret, payload));
  const b = Buffer.from(sig);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  let c: Partial<PrintLinkClaims>;
  try {
    c = JSON.parse(payload);
  } catch {
    return null;
  }
  if (!isPrintLinkKind(c.kind) || typeof c.id !== "string" || typeof c.tenantId !== "string") return null;
  if (typeof c.exp !== "number" || c.exp < nowSeconds) return null;
  return { kind: c.kind, id: c.id, tenantId: c.tenantId, exp: c.exp };
}
