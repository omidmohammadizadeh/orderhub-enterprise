/** Which of our restaurant apps placed an order, if any.
 *
 *  The customer apps (apps/customer) show the storefront in a WebView whose
 *  user agent ends in "OrderHubApp/<brand slug>"; the rest of the string is
 *  the phone's own WebView agent, which says Android or iPhone/iPad. Staff
 *  read the result on the order ("App · Android") to see who ordered from
 *  the app rather than the website. */
export type AppClient = { app: string; platform: "ios" | "android" | "unknown" };

export function appClientFromUserAgent(userAgent?: string | null): AppClient | null {
  if (!userAgent) return null;
  const match = /OrderHubApp\/([a-z0-9]{1,40})/i.exec(userAgent);
  if (!match) return null;
  const platform = /Android/i.test(userAgent)
    ? "android"
    : /iPhone|iPad|iPod|iOS/i.test(userAgent)
      ? "ios"
      : "unknown";
  return { app: (match[1] ?? "").toLowerCase(), platform };
}
