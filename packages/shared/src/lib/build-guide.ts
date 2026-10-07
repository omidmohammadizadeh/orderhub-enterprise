/**
 * "How to build" kitchen guides — shared between the API (which stores a
 * guide under brand + nameKey) and the web (which decides whether an order
 * line has a guide before showing the button).
 *
 * Guides are matched by product NAME because order lines from marketplaces
 * often carry no menuItemId, and a menu cloned to another location copies its
 * items with new ids. The name is the one thing every copy has in common.
 */

export interface BuildGuideStep {
  id: string;
  text: string;
  imageUrl?: string | null;
  /** "2 scoops", "120g" — optional, printed as a badge next to the step */
  amount?: string | null;
  /** "Spatula", "Squeeze bottle" — optional tool tags */
  tools?: string[];
  /**
   * Modifier-aware steps. `onlyWith`: the step is for an extra — shown
   * highlighted when the order has one of these modifiers, greyed out as
   * "not ordered" otherwise. `skipWith`: a step the customer can remove
   * ("No onion") — struck through when one of these is on the order.
   * Both hold modifier option NAMES, matched with buildGuideNameKey.
   */
  onlyWith?: string[];
  skipWith?: string[];
  /** Seconds into the guide's YouTube video where THIS step is shown */
  videoStart?: number | null;
}

export interface BuildGuideDto {
  id: string;
  brandId: string;
  name: string;
  nameKey: string;
  steps: BuildGuideStep[];
  packNote: string | null;
  /** Unlisted/public YouTube video of the whole build (any YouTube URL form) */
  videoUrl: string | null;
  updatedAt: string;
}

export const BUILD_GUIDE_MAX_STEPS = 30;

/** "Chicken Burger (Large)" → "chicken burger large". Accents and punctuation dropped. */
export function buildGuideNameKey(name: string | null | undefined): string {
  return String(name ?? "")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9؀-ۿ一-鿿]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

/**
 * Which guide key serves this order line? Exact name first; otherwise the
 * longest guide key the line STARTS with on a word boundary — a marketplace
 * line called "Chicken Burger Large" still finds the "Chicken Burger" guide,
 * but "Chicken" never swallows "Chicken Wings" when both exist.
 */
export function matchBuildGuideKey(
  lineName: string | null | undefined,
  keys: Iterable<string>,
): string | null {
  const line = buildGuideNameKey(lineName);
  if (!line) return null;
  let best: string | null = null;
  for (const key of keys) {
    if (!key) continue;
    if (key === line) return key;
    if (line.startsWith(key + " ") && (!best || key.length > best.length)) best = key;
  }
  return best;
}

/** Does an ordered modifier satisfy a step condition? Exact key, or the
 *  condition's words appearing whole inside the modifier ("Cheese" matches
 *  "Extra Cheese", never "Cheesecake"). */
function modifierMatches(conditionKey: string, modifierKey: string): boolean {
  if (!conditionKey || !modifierKey) return false;
  if (conditionKey === modifierKey) return true;
  return ` ${modifierKey} `.includes(` ${conditionKey} `);
}

export type BuildStepState = "always" | "added" | "notOrdered" | "skipped";

/**
 * How a step applies to THIS order line, given the names of its modifiers.
 * A skip beats an add: "No sauce" wins even if the step also lists "Sauce".
 */
export function buildStepState(
  step: Pick<BuildGuideStep, "onlyWith" | "skipWith">,
  modifierNames: Array<string | null | undefined>,
): { state: BuildStepState; matched: string[] } {
  const mods = modifierNames
    .map((n) => ({ name: String(n ?? ""), key: buildGuideNameKey(n) }))
    .filter((m) => m.key);
  const hits = (conds?: string[]) =>
    mods
      .filter((m) => (conds ?? []).some((c) => modifierMatches(buildGuideNameKey(c), m.key)))
      .map((m) => m.name);

  const skipped = hits(step.skipWith);
  if (skipped.length) return { state: "skipped", matched: skipped };
  if ((step.onlyWith ?? []).filter((c) => buildGuideNameKey(c)).length) {
    const added = hits(step.onlyWith);
    return added.length ? { state: "added", matched: added } : { state: "notOrdered", matched: [] };
  }
  return { state: "always", matched: [] };
}

// ── YouTube ─────────────────────────────────────────────────────────────────
// Guides store the URL the operator pasted; everything else derives from the
// 11-character video id. Playback is a plain embed in the viewer's browser —
// no YouTube Data API, no key, no quota, nothing passes through our server.

const YT_ID = /^[A-Za-z0-9_-]{11}$/;

/**
 * Video id from watch / youtu.be / shorts / embed / live / m. links, or a bare id.
 * Plain string parsing on purpose: this package compiles with neither the DOM
 * lib nor @types/node in the Docker images, so the WHATWG `URL` global is not
 * available to the type checker there (it broke every Render build once).
 */
export function parseYouTubeId(input: string | null | undefined): string | null {
  const raw = String(input ?? "").trim();
  if (!raw) return null;
  if (YT_ID.test(raw)) return raw;
  const m = raw.match(/^(?:https?:\/\/)?([^/?#]+)([^?#]*)(?:\?([^#]*))?/i);
  if (!m) return null;
  const host = (m[1] ?? "").toLowerCase().replace(/:\d+$/, "").replace(/^(www|m|music)\./, "");
  const path = m[2] ?? "";
  const query = m[3] ?? "";
  let id: string | null = null;
  if (host === "youtu.be") id = path.split("/")[1] ?? null;
  else if (host === "youtube.com" || host === "youtube-nocookie.com") {
    if (path === "/watch") {
      const v = query.split("&").find((kv) => kv.startsWith("v="));
      id = v ? decodeURIComponent(v.slice(2)) : null;
    } else {
      id = path.match(/^\/(?:shorts|embed|live|v)\/([^/]+)/)?.[1] ?? null;
    }
  }
  return id && YT_ID.test(id) ? id : null;
}

/** "1:05", "65", "1m5s", "0:01:05" → seconds; null when blank or unreadable. */
export function parseVideoTime(input: string | number | null | undefined): number | null {
  if (typeof input === "number") return Number.isFinite(input) && input >= 0 ? Math.floor(input) : null;
  const t = String(input ?? "").trim().toLowerCase();
  if (!t) return null;
  if (/^\d+$/.test(t)) return Number(t);
  const hms = t.match(/^(?:(\d+):)?(\d{1,2}):(\d{1,2})$/);
  if (hms) return Number(hms[1] ?? 0) * 3600 + Number(hms[2]) * 60 + Number(hms[3]);
  const unit = t.match(/^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/);
  if (unit && (unit[1] || unit[2] || unit[3])) {
    return Number(unit[1] ?? 0) * 3600 + Number(unit[2] ?? 0) * 60 + Number(unit[3] ?? 0);
  }
  return null;
}

export function formatVideoTime(seconds: number | null | undefined): string {
  if (seconds == null || !Number.isFinite(seconds)) return "";
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${sec}` : `${m}:${sec}`;
}

/** Privacy-enhanced embed; `start` jumps to a step. */
export function youTubeEmbedUrl(id: string, opts: { start?: number | null; autoplay?: boolean } = {}): string {
  const q = ["rel=0", "playsinline=1", "modestbranding=1"];
  if (opts.start) q.push(`start=${Math.floor(opts.start)}`);
  if (opts.autoplay) q.push("autoplay=1");
  return `https://www.youtube-nocookie.com/embed/${id}?${q.join("&")}`;
}

/** Normal watch link (for the printed QR code — opens the YouTube app on a phone). */
export function youTubeWatchUrl(id: string, start?: number | null): string {
  return `https://youtu.be/${id}${start ? `?t=${Math.floor(start)}` : ""}`;
}

export function youTubeThumbnail(id: string): string {
  return `https://i.ytimg.com/vi/${id}/hqdefault.jpg`;
}
