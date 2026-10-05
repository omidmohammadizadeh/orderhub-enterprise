import type { Logger } from "@nestjs/common";
import type { SupabaseStorageService } from "../../uploads/supabase-storage.service";

// Copy imported product photos onto our own storage at import time.
//
// A marketplace photo URL is someone else's resource: Deliveroo's HubRise-CDN
// links expire within hours, and any CDN can rename or drop a file. Fetching
// once while the link is known-good and keeping our own copy is what makes an
// imported photo still be there next month.

export interface RehostOptions {
  /** Storage folder for the uploaded copies. */
  folder: string;
  /** Prefix for log lines, e.g. "Deliveroo menu import". */
  label: string;
  logger: Logger;
  /**
   * What a product keeps when its photo could not be fetched.
   * "keep" leaves the original URL (Deliveroo's historical behaviour);
   * "drop" clears it, so a dead link never renders as a broken image.
   */
  onFailure: "keep" | "drop";
  /** Origins that are already ours and must not be re-fetched. */
  skipOrigins?: string[];
  /**
   * Stop starting new fetches after this long. Imports are synchronous behind
   * a ~60s proxy, so a huge menu must not spend it all on photos; anything
   * not reached keeps its original URL.
   */
  budgetMs?: number;
  concurrency?: number;
}

export interface RehostResult {
  attempted: number;
  rehosted: number;
  failed: number;
  /** Unique URLs never fetched because the time budget ran out. */
  skipped: number;
}

const MAX_BYTES = 8 * 1024 * 1024;

/**
 * Only fetch what is plainly a public web image. The JSON import takes URLs
 * typed into a file, so refuse anything aimed at this server's own network
 * (localhost, bare IPs, internal names) rather than fetching it.
 */
export function isFetchableImageUrl(url: string): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return false;
  const host = u.hostname.toLowerCase();
  if (!host.includes(".")) return false; // localhost, single-label names
  if (/^[\d.]+$/.test(host) || host.includes(":") || host.startsWith("[")) return false;
  if (/\.(local|internal|localhost)$/.test(host)) return false;
  return true;
}

export async function rehostProductImages(
  storage: SupabaseStorageService | null | undefined,
  products: Array<{ imageUrl?: string | null }>,
  opts: RehostOptions,
): Promise<RehostResult> {
  const empty = { attempted: 0, rehosted: 0, failed: 0, skipped: 0 };
  if (!storage?.isConfigured()) return empty;

  const skip = opts.skipOrigins ?? [];
  const targets = products.filter(
    (p) =>
      p.imageUrl &&
      /^https?:\/\//i.test(p.imageUrl) &&
      !skip.some((o) => p.imageUrl!.startsWith(`${o}/`)),
  );
  if (targets.length === 0) return empty;
  opts.logger.log(
    `${opts.label}: rehosting ${targets.length} images (sample: ${targets[0]!.imageUrl!.slice(0, 160)})`,
  );

  const rehostOne = async (url: string): Promise<string | null> => {
    if (!isFetchableImageUrl(url)) return null;
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
      if (!res.ok) {
        opts.logger.warn(`${opts.label}: image fetch ${res.status} for ${url.slice(0, 120)}`);
        return null;
      }
      const ct = res.headers.get("content-type") ?? "image/jpeg";
      if (!ct.startsWith("image/")) return null;
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length === 0 || buf.length > MAX_BYTES) return null;
      return await storage.uploadDataUrl(
        `data:${ct.split(";")[0]};base64,${buf.toString("base64")}`,
        opts.folder,
      );
    } catch (err: any) {
      opts.logger.warn(
        `${opts.label}: image rehost failed for ${url.slice(0, 120)}: ${err?.message ?? err}`,
      );
      return null;
    }
  };

  // One fetch per unique URL — meal-deal twins often share a photo.
  const results = new Map<string, string | null>();
  const urls = [...new Set(targets.map((p) => p.imageUrl!))];
  const deadline = opts.budgetMs ? Date.now() + opts.budgetMs : Infinity;
  const chunk = opts.concurrency ?? 5;
  let skipped = 0;
  for (let i = 0; i < urls.length; i += chunk) {
    if (Date.now() > deadline) {
      skipped = urls.length - i;
      break;
    }
    await Promise.all(
      urls.slice(i, i + chunk).map(async (u) => results.set(u, await rehostOne(u))),
    );
  }

  for (const p of targets) {
    const url = p.imageUrl!;
    if (!results.has(url)) continue; // never reached — keep the original
    const hosted = results.get(url);
    if (hosted) p.imageUrl = hosted;
    else if (opts.onFailure === "drop") p.imageUrl = null;
  }

  const rehosted = [...results.values()].filter(Boolean).length;
  const result = { attempted: urls.length, rehosted, failed: results.size - rehosted, skipped };
  opts.logger.log(
    `${opts.label}: rehosted ${rehosted}/${urls.length} unique images` +
      (result.failed ? `, ${result.failed} failed` : "") +
      (skipped ? `, ${skipped} skipped (time budget)` : ""),
  );
  return result;
}
