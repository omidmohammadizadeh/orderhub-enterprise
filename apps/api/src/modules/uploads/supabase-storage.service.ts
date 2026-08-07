import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { createClient, SupabaseClient } from "@supabase/supabase-js";
import { randomUUID } from "crypto";

// Phase AL — menu/product image storage on Supabase Storage. The dashboard
// uploader sends a resized data URL; we decode it and push the bytes into a
// PUBLIC bucket, then return the public https URL to save on the row. Real
// https URLs are required by WhatsApp (image.link), the storefront, and keep
// the DB lean (vs. storing base64). Falls back gracefully when unconfigured.
@Injectable()
export class SupabaseStorageService {
  private readonly logger = new Logger(SupabaseStorageService.name);
  private readonly client: SupabaseClient | null;
  private readonly bucket: string;

  constructor(private readonly config: ConfigService) {
    const url = this.config.get<string>("SUPABASE_URL");
    const key = this.config.get<string>("SUPABASE_SERVICE_ROLE_KEY");
    this.bucket = this.config.get<string>("SUPABASE_STORAGE_BUCKET") || "menu-images";
    this.client = url && key ? this.buildClient(url, key) : null;
    if (!this.client) {
      this.logger.warn(
        "Supabase not configured (SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY) — image uploads fall back to data URLs",
      );
    }
  }

  /**
   * Build the Supabase client without ever being able to take the API down.
   *
   * We only use Storage, but supabase-js is all-or-nothing: its constructor
   * always builds a RealtimeClient, and on Node < 22 (no global WebSocket)
   * that THROWS. Because this service is constructed at boot, that turned an
   * optional image-hosting feature into a total startup failure the moment
   * the env vars were finally set.
   *
   * Two guards, in order of preference:
   *  1. hand Realtime a `ws` transport so it constructs cleanly;
   *  2. if anything still throws, degrade to null — uploads fall back to data
   *     URLs exactly as they did when Supabase was unconfigured. An optional
   *     dependency must never be able to stop orders being taken.
   */
  private buildClient(url: string, key: string): SupabaseClient | null {
    try {
      // Node 20 has no global WebSocket. Resolved lazily so a missing package
      // is a degraded feature, not a crash.
      let transport: unknown;
      try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        transport = require("ws");
      } catch {
        transport = undefined;
      }
      return createClient(url, key, {
        auth: { persistSession: false },
        ...(transport ? { realtime: { transport: transport as any } } : {}),
      });
    } catch (e: any) {
      this.logger.error(
        `Supabase client failed to initialise — image uploads will fall back to data URLs: ${e?.message ?? e}`,
      );
      return null;
    }
  }

  isConfigured(): boolean {
    return this.client !== null;
  }

  /**
   * Upload an image given as a data URL (data:image/...;base64,...) or pass
   * through an existing http(s) URL unchanged. Returns the public https URL.
   */
  async uploadDataUrl(dataUrl: string, folder = "products"): Promise<string> {
    // Already a hosted URL (paste-a-URL path) — nothing to do.
    if (/^https?:\/\//i.test(dataUrl)) return dataUrl;
    if (!this.client) {
      throw new Error("Supabase storage is not configured");
    }
    const match = /^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/.exec(dataUrl);
    const contentType = match?.[1];
    const b64 = match?.[2];
    if (!contentType || !b64) {
      throw new Error("Expected an image data URL");
    }
    const body = new Blob([Buffer.from(b64, "base64")], { type: contentType });
    const ext = this.extFor(contentType);
    const path = `${folder}/${randomUUID()}.${ext}`;

    const { error } = await this.client.storage
      .from(this.bucket)
      .upload(path, body, { contentType, upsert: false });
    if (error) {
      this.logger.error(`Supabase upload failed: ${error.message}`);
      throw new Error(`Upload failed: ${error.message}`);
    }
    const { data } = this.client.storage.from(this.bucket).getPublicUrl(path);
    return data.publicUrl;
  }

  /**
   * Upload raw bytes (e.g. a generated MP4) and return the public URL. Used by
   * the Video Studio to persist finished renders — the provider's output URL is
   * temporary, so we re-host it.
   */
  /** Which bucket we write to — surfaced so a diagnostic can name it. */
  bucketName(): string {
    return this.bucket;
  }

  /**
   * Prove an upload of this content type actually works, and return the real
   * reason when it does not.
   *
   * Exists because every failure here surfaces to the operator as "the video
   * won't play", with the actual cause — a bucket that only allows image/*,
   * or a size cap below a short clip — visible nowhere. Guessing at that from
   * the outside cost several rounds; asking Supabase directly answers it.
   */
  async selfTest(contentType = "video/mp4", ext = "mp4") {
    if (!this.client) {
      return {
        ok: false as const,
        bucket: this.bucket,
        stage: "config" as const,
        error:
          "Supabase is not configured — set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY",
      };
    }
    // A few bytes is enough: we are testing permission and MIME acceptance,
    // not throughput.
    const path = `diagnostics/${randomUUID()}.${ext}`;
    const body = new Blob([Buffer.from([0, 0, 0, 0])], { type: contentType });
    const { error } = await this.client.storage
      .from(this.bucket)
      .upload(path, body, { contentType, upsert: false });
    if (error) {
      return {
        ok: false as const,
        bucket: this.bucket,
        stage: "upload" as const,
        error: error.message,
      };
    }
    const { data } = this.client.storage.from(this.bucket).getPublicUrl(path);
    // Read it back: an upload that succeeds into a PRIVATE bucket still
    // produces a URL the browser cannot fetch, which looks identical to a
    // dead link from the outside.
    let readable = false;
    let readError: string | undefined;
    try {
      const res = await fetch(data.publicUrl);
      readable = res.ok;
      if (!res.ok) readError = `${res.status} ${res.statusText}`;
    } catch (err: any) {
      readError = err?.message;
    }
    await this.client.storage.from(this.bucket).remove([path]);
    return {
      ok: readable,
      bucket: this.bucket,
      stage: readable ? ("ok" as const) : ("read" as const),
      error: readable
        ? undefined
        : `Uploaded fine, but the public URL is not readable (${readError ?? "unknown"}) — the bucket is probably private.`,
      publicUrl: data.publicUrl,
    };
  }

  async uploadBuffer(
    buffer: Buffer,
    contentType: string,
    folder = "videos",
    ext = "mp4",
  ): Promise<string> {
    if (!this.client) throw new Error("Supabase storage is not configured");
    const body = new Blob([buffer], { type: contentType });
    const path = `${folder}/${randomUUID()}.${ext}`;
    const { error } = await this.client.storage
      .from(this.bucket)
      .upload(path, body, { contentType, upsert: false });
    if (error) {
      this.logger.error(`Supabase upload (buffer) failed: ${error.message}`);
      throw new Error(`Upload failed: ${error.message}`);
    }
    const { data } = this.client.storage.from(this.bucket).getPublicUrl(path);
    return data.publicUrl;
  }

  private extFor(contentType: string): string {
    switch (contentType) {
      case "image/jpeg":
      case "image/jpg":
        return "jpg";
      case "image/png":
        return "png";
      case "image/webp":
        return "webp";
      case "image/gif":
        return "gif";
      default:
        return "jpg";
    }
  }
}
