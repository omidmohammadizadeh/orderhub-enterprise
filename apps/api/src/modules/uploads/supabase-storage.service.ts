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
    this.client =
      url && key ? createClient(url, key, { auth: { persistSession: false } }) : null;
    if (!this.client) {
      this.logger.warn(
        "Supabase not configured (SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY) — image uploads fall back to data URLs",
      );
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
