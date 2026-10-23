/** The production API origin, for when no env var holds a usable URL. */
export const PROD_API_ORIGIN = "https://orderhub-api-0re6.onrender.com";

/**
 * Public base of our API as a third party must call it, INCLUDING the global
 * "/api" prefix main.ts sets — append "/v1/…" to it.
 *
 * Two traps on Render (2026-10-22):
 *  - API_URL is the bare host, without "/api", so "${API_URL}/v1/…" is a 404.
 *    Tap's webhooks and Mollie's OAuth redirect both shipped that way.
 *  - API_PUBLIC_URL is the bare Render SERVICE NAME ("orderhub-api-0re6"), not
 *    a URL, so anything built on it isn't an address at all (WhatsApp).
 *
 * So: the first of API_URL / API_PUBLIC_URL / PUBLIC_API_URL that is a full
 * http(s) URL, else production; "/api" added unless it is already there.
 */
export function publicApiBase(env: NodeJS.ProcessEnv = process.env): string {
  const origin =
    [env.API_URL, env.API_PUBLIC_URL, env.PUBLIC_API_URL]
      .map((v) => (v ?? "").trim().replace(/\/+$/, ""))
      .find((v) => /^https?:\/\//i.test(v)) ?? PROD_API_ORIGIN;
  return /\/api$/i.test(origin) ? origin : `${origin}/api`;
}
