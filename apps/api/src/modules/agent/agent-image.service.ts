import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import sharp from "sharp";
import { PrismaService } from "../../infrastructure/database/prisma.service";
import { MenusService } from "../menus/menus.service";
import { ReplicateProvider } from "../video-studio/replicate.provider";
import { SupabaseStorageService } from "../uploads/supabase-storage.service";

// ── AI product-image generation for the admin agent ─────────────────────────
//
// Generates a realistic food photo for a menu item from its name and
// DESCRIPTION, crops it to the exact size the menu card expects, hosts it,
// and sets it on the item through the validated MenusService.
//
// Provider: Gemini when GEMINI_API_KEY is set (about a tenth of the cost per
// image, and the key is already on the API), otherwise Replicate. Force the
// old path with AGENT_IMAGE_PROVIDER=replicate.
//
// Two decisions worth keeping:
//  - COVER-crop to 1064x768, not "fit inside". Fitting leaves whatever aspect
//    the model returned, so a square generation renders letterboxed in the
//    card.
//  - Upload to storage and store the URL. A data: URL rides in every payload
//    carrying that item — menu load, POS catalogue, kiosk — so a 100-item
//    menu would drag ~10MB of base64 around on every request.
//
// Rate-limit / cost safety:
//  - Single-item generation runs inline (one call, seconds).
//  - Bulk runs as a THROTTLED background job — at most IMAGE_CONCURRENCY in
//    flight — so a 180-item menu never fires 180 simultaneous calls. Scope it
//    with categoryId; a whole menu is rarely what's wanted and always costs
//    the most.

const DEFAULT_IMAGE_MODEL = "black-forest-labs/flux-schnell";
// Gemini is roughly a tenth of Replicate's cost per image and its key is
// already on the API for other features, so it's preferred when present.
// AGENT_IMAGE_PROVIDER=replicate forces the old path back.
const DEFAULT_GEMINI_MODEL = "gemini-2.5-flash-image";
const DEFAULT_OPENAI_MODEL = "gpt-image-2";
// 3:2 is the closest landscape size OpenAI offers to the 1064x768 card
// (1.385). Everything is cover-cropped afterwards, so the only cost of the
// mismatch is a trimmed sliver rather than a distorted plate.
const OPENAI_SIZE = "1536x1024";
const IMAGE_CONCURRENCY = 2;
// The menu card, the storefront tile and the POS grid are all built for this.
// Anything else gets letterboxed or cropped by the browser instead.
const IMAGE_W = 1064;
const IMAGE_H = 768;
const POLL_INTERVAL_MS = 1500;
const POLL_TIMEOUT_MS = 90_000;

export interface BulkJob {
  status: "running" | "done";
  total: number;
  done: number;
  failed: number;
  startedAt: number;
}

@Injectable()
export class AgentImageService {
  private readonly logger = new Logger(AgentImageService.name);
  private readonly model: string;
  private readonly bulkJobs = new Map<string, BulkJob>();

  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
    private readonly menus: MenusService,
    private readonly replicate: ReplicateProvider,
    private readonly storage: SupabaseStorageService,
  ) {
    this.model = this.config.get<string>("AGENT_IMAGE_MODEL") ?? DEFAULT_IMAGE_MODEL;
  }

  /**
   * Which generator to use.
   *
   * AGENT_IMAGE_PROVIDER wins when set, so switching to compare quality is an
   * env change rather than a deploy. Otherwise Gemini, which at 2.5 Flash
   * Image is the cheapest of the three per photo.
   */
  private get provider(): "openai" | "gemini" | "replicate" {
    const forced = this.config.get<string>("AGENT_IMAGE_PROVIDER");
    if (forced === "openai" || forced === "gemini" || forced === "replicate") {
      return forced;
    }
    if (this.config.get<string>("GEMINI_API_KEY")) return "gemini";
    if (this.config.get<string>("OPENAI_API_KEY")) return "openai";
    return "replicate";
  }

  get configured(): boolean {
    const p = this.provider;
    if (p === "gemini") return !!this.config.get<string>("GEMINI_API_KEY");
    if (p === "openai") return !!this.config.get<string>("OPENAI_API_KEY");
    return !!this.config.get<string>("REPLICATE_API_TOKEN");
  }

  /** Named so the operator is told which key to set, not just "not configured". */
  private get notConfiguredMessage(): string {
    const p = this.provider;
    const key =
      p === "gemini"
        ? "GEMINI_API_KEY"
        : p === "openai"
          ? "OPENAI_API_KEY"
          : "REPLICATE_API_TOKEN";
    return (
      `Image generation is set to ${p} but ${key} is not set in the API ` +
      `environment. Set it, or change AGENT_IMAGE_PROVIDER to a provider ` +
      `whose key is present.`
    );
  }

  // MenuItem has only a scalar brandId (no `brand` relation), so item queries
  // scope by the tenant's brand ids.
  private async tenantBrandIds(tenantId: string): Promise<string[]> {
    const brands = await (this.prisma as any).brand.findMany({
      where: { tenantId },
      select: { id: true },
    });
    return brands.map((b: any) => b.id);
  }

  /** Generate + store one item's photo inline. Returns the stored data URL. */
  async generateForItem(
    tenantId: string,
    itemId: string,
    styleHint?: string,
  ): Promise<{ ok: boolean; itemId: string; error?: string }> {
    if (!this.configured) {
      return { ok: false, itemId, error: this.notConfiguredMessage };
    }
    const brandIds = await this.tenantBrandIds(tenantId);
    const item = await (this.prisma as any).menuItem.findFirst({
      where: { id: itemId, brandId: { in: brandIds } },
      select: { id: true, name: true, description: true },
    });
    if (!item) return { ok: false, itemId, error: "Item not found for this business." };

    const imageUrl = await this.renderImage(item.name, item.description, styleHint);
    await this.menus.updateItem(itemId, tenantId, { imageUrl } as any);
    return { ok: true, itemId };
  }

  /** Start a THROTTLED background job to photograph a whole menu's items. */
  startBulkForMenu(
    tenantId: string,
    menuId: string,
    onlyMissing: boolean,
    styleHint?: string,
    /** Photograph one category only — "just the wraps" is the common ask. */
    categoryId?: string,
  ): { jobId: string } | { error: string } {
    if (!this.configured) {
      return { error: this.notConfiguredMessage };
    }
    const jobId = `img_${menuId}_${this.bulkJobs.size}`;
    const job: BulkJob = { status: "running", total: 0, done: 0, failed: 0, startedAt: 0 };
    this.bulkJobs.set(jobId, job);
    void this.runBulk(tenantId, menuId, onlyMissing, styleHint, job, categoryId).catch((e) =>
      this.logger.error(`bulk image job ${jobId} crashed: ${(e as Error).message}`),
    );
    return { jobId };
  }

  getBulkJob(jobId: string): BulkJob | null {
    return this.bulkJobs.get(jobId) ?? null;
  }

  private async runBulk(
    tenantId: string,
    menuId: string,
    onlyMissing: boolean,
    styleHint: string | undefined,
    job: BulkJob,
    categoryId?: string,
  ) {
    const brandIds = await this.tenantBrandIds(tenantId);
    // Scoping by category goes through the category link, not menuIds[] — an
    // item can sit in several categories of the same menu, and only the link
    // says which.
    const categoryItemIds = categoryId
      ? (
          await (this.prisma as any).menuItemOnCategory.findMany({
            where: { categoryId, category: { menuId } },
            select: { itemId: true },
          })
        ).map((r: any) => r.itemId)
      : null;

    const items = await (this.prisma as any).menuItem.findMany({
      where: {
        ...(categoryItemIds
          ? { id: { in: categoryItemIds } }
          : { menuIds: { has: menuId } }),
        brandId: { in: brandIds },
        ...(onlyMissing ? { OR: [{ imageUrl: null }, { imageUrl: "" }] } : {}),
      },
      select: { id: true, name: true, description: true },
      take: 500,
    });
    job.total = items.length;

    // Concurrency-limited worker pool — never more than IMAGE_CONCURRENCY
    // Replicate calls at once.
    let cursor = 0;
    const worker = async () => {
      for (;;) {
        const idx = cursor++;
        if (idx >= items.length) return;
        const it = items[idx];
        try {
          const imageUrl = await this.renderImage(it.name, it.description, styleHint);
          await this.menus.updateItem(it.id, tenantId, { imageUrl } as any);
          job.done++;
        } catch (e) {
          job.failed++;
          this.logger.warn(`image gen failed for ${it.id}: ${(e as Error).message}`);
        }
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(IMAGE_CONCURRENCY, items.length) }, () => worker()),
    );
    job.status = "done";
  }

  /**
   * The prompt.
   *
   * The DESCRIPTION does the work. A name is a label and often a brand —
   * "Filthy Box" describes nothing — while the description lists what's
   * actually in the dish ("chicken, doner, pitta and garlic sauce in a 14
   * inch box with a coke"). Prompting from the name alone invents a
   * different meal that happens to share a title.
   */
  private buildPrompt(
    name: string,
    description: string | null | undefined,
    styleHint?: string,
  ): string {
    return (
      `Professional studio food photography of "${name}"` +
      (description ? `, ${description}` : "") +
      (styleHint ? `. ${styleHint}` : "") +
      `. Appetising, freshly served, soft directional studio lighting, shallow ` +
      `depth of field, clean seamless background, three-quarter angle, high ` +
      `detail, realistic, restaurant menu quality. No text, no watermark, ` +
      `no hands, no people.`
    );
  }

  /** Generate, crop to the exact menu-card size, and host it. Returns a URL. */
  private async renderImage(
    name: string,
    description: string | null | undefined,
    styleHint?: string,
  ): Promise<string> {
    const prompt = this.buildPrompt(name, description, styleHint);
    const p = this.provider;
    const raw =
      p === "gemini"
        ? await this.renderWithGemini(prompt)
        : p === "openai"
          ? await this.renderWithOpenAI(prompt)
          : await this.renderWithReplicate(prompt);

    // COVER, not "fit inside". `fit: inside` leaves whatever aspect the model
    // returned, so a square generation renders letterboxed in a 4:3 card;
    // cover fills the box and crops the overflow, which is what a menu tile
    // actually wants.
    const jpeg = await sharp(raw)
      .resize(IMAGE_W, IMAGE_H, { fit: "cover", position: "centre" })
      .jpeg({ quality: 82 })
      .toBuffer();
    const dataUrl = `data:image/jpeg;base64,${jpeg.toString("base64")}`;

    // Host it rather than storing the bytes on the row. A data URL rides in
    // every payload that carries the item — menu load, POS catalogue, kiosk —
    // so a 100-item menu drags ~10MB of base64 around on every request.
    try {
      return await this.storage.uploadDataUrl(dataUrl, "agent-images");
    } catch (e) {
      // Storage down or unconfigured shouldn't lose a paid-for generation.
      this.logger.warn(
        `storage upload failed, storing inline instead: ${(e as Error).message}`,
      );
      return dataUrl;
    }
  }

  /** Gemini: one call, image comes back inline as base64. */
  private async renderWithGemini(prompt: string): Promise<Buffer> {
    const key = this.config.get<string>("GEMINI_API_KEY");
    const model =
      this.config.get<string>("AGENT_GEMINI_IMAGE_MODEL") ?? DEFAULT_GEMINI_MODEL;
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(key ?? "")}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: {
            responseModalities: ["IMAGE"],
            imageConfig: { aspectRatio: "4:3" },
          },
        }),
      },
    );
    if (!res.ok) {
      throw new Error(
        `Gemini ${res.status}: ${(await res.text().catch(() => "")).slice(0, 200)}`,
      );
    }
    const json: any = await res.json();
    const parts = json?.candidates?.[0]?.content?.parts ?? [];
    const inline = parts.find((p: any) => p?.inlineData?.data);
    if (!inline) {
      // A refusal comes back as text. Say what it said rather than "no image".
      const text = parts.map((p: any) => p?.text).filter(Boolean).join(" ");
      throw new Error(`no image returned${text ? `: ${text.slice(0, 160)}` : ""}`);
    }
    return Buffer.from(inline.inlineData.data, "base64");
  }

  /** OpenAI: one call, image comes back base64 in data[0].b64_json. */
  private async renderWithOpenAI(prompt: string): Promise<Buffer> {
    const res = await fetch("https://api.openai.com/v1/images/generations", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.config.get<string>("OPENAI_API_KEY") ?? ""}`,
      },
      body: JSON.stringify({
        model:
          this.config.get<string>("AGENT_OPENAI_IMAGE_MODEL") ?? DEFAULT_OPENAI_MODEL,
        prompt,
        size: OPENAI_SIZE,
        // Quality drives both the look and the bill, so it's tunable without
        // a deploy. Medium is the sensible middle for a menu tile.
        quality: this.config.get<string>("AGENT_OPENAI_IMAGE_QUALITY") ?? "medium",
        n: 1,
      }),
    });
    if (!res.ok) {
      throw new Error(
        `OpenAI ${res.status}: ${(await res.text().catch(() => "")).slice(0, 200)}`,
      );
    }
    const json: any = await res.json();
    const b64 = json?.data?.[0]?.b64_json;
    if (!b64) {
      // Some models return a URL instead of inline base64 — follow it rather
      // than failing on a response that did contain an image.
      const url = json?.data?.[0]?.url;
      if (url) {
        const img = await fetch(url);
        if (!img.ok) throw new Error(`could not download image (${img.status})`);
        return Buffer.from(await img.arrayBuffer());
      }
      throw new Error("no image returned");
    }
    return Buffer.from(b64, "base64");
  }

  /** Replicate: create → poll → download. */
  private async renderWithReplicate(prompt: string): Promise<Buffer> {
    const started = await this.replicate.createPrediction({
      prompt,
      model: this.model,
      imageKey: "", // text-to-image: no start image
      extra: { aspect_ratio: "4:3", output_format: "webp", num_outputs: 1 },
    });

    const deadline = Date.now() + POLL_TIMEOUT_MS;
    let output: unknown = null;
    for (;;) {
      if (Date.now() > deadline) throw new Error("image generation timed out");
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
      const st = await this.replicate.getPrediction(started.id);
      if (st.status === "succeeded") {
        output = st.output;
        break;
      }
      if (st.status === "failed" || st.status === "canceled") {
        throw new Error(st.error || `generation ${st.status}`);
      }
    }

    const url = this.replicate.outputUrl(output);
    if (!url) throw new Error("no image returned");

    const res = await fetch(url);
    if (!res.ok) throw new Error(`could not download image (${res.status})`);
    // Sizing and hosting are the caller's job now — both providers hand back
    // raw bytes so there is exactly one place that decides the output shape.
    return Buffer.from(await res.arrayBuffer());
  }
}
