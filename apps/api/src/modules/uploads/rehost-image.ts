import { Logger } from "@nestjs/common";
import type { SupabaseStorageService } from "./supabase-storage.service";

const logger = new Logger("rehostImage");

/**
 * Turn an inline image into a hosted one before it reaches the database.
 *
 * Logos arrive from the dashboard as `data:image/png;base64,…` — the whole
 * picture as text. Stored like that they sit in a Postgres column and are
 * re-sent inside the JSON on every single storefront load, because a data URI
 * is part of the response rather than a resource the browser can cache. One
 * real shop was carrying a 304KB logo this way, 31% of a 2MB payload, for an
 * image the page draws once and that never changes between visits.
 *
 * Uploading it and keeping the URL instead means the bytes leave the payload
 * entirely and the browser caches the file after the first visit.
 *
 * Deliberately never throws. A logo that fails to upload must not block the
 * operator from saving their opening hours — we keep the data URI, which is
 * exactly today's behaviour, and log it. Slow is better than broken.
 */
export async function rehostImageIfInline(
  storage: SupabaseStorageService | null | undefined,
  value: string | null | undefined,
  folder: string,
): Promise<string | null | undefined> {
  // Untouched: absent, cleared, or already a URL.
  if (!value || !value.startsWith("data:")) return value;
  if (!storage?.isConfigured?.()) {
    logger.warn(
      `Storage not configured — keeping a ${Math.round(value.length / 1024)}KB inline image in the database`,
    );
    return value;
  }
  try {
    const url = await storage.uploadDataUrl(value, folder);
    logger.log(
      `Rehosted a ${Math.round(value.length / 1024)}KB inline image to ${folder}`,
    );
    return url;
  } catch (err: any) {
    logger.error(`Rehost failed, keeping it inline: ${err?.message ?? err}`);
    return value;
  }
}
