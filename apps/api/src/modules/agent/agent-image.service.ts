import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import sharp from "sharp";
import { PrismaService } from "../../infrastructure/database/prisma.service";
import { MenusService } from "../menus/menus.service";
import { ReplicateProvider } from "../video-studio/replicate.provider";

// ── AI product-image generation for the admin agent ─────────────────────────
//
// Generates a realistic food photo for a menu item from its name/description
// via Replicate (default flux-schnell), downscales it to a compact webp, and
// stores it on the item as a data: URL through the validated MenusService.
//
// Rate-limit / cost safety:
//  - Single-item generation runs inline (one Replicate call, seconds).
//  - Bulk (a whole menu) runs as a THROTTLED background job — at most
//    IMAGE_CONCURRENCY in flight — so a 180-item menu never fires 180
//    simultaneous Replicate calls. The agent gets an immediate "started"
//    and the photos appear over the following minutes.
//  - Needs REPLICATE_API_TOKEN. Without it, generation reports a clear error
//    instead of failing obscurely.

const DEFAULT_IMAGE_MODEL = "black-forest-labs/flux-schnell";
const IMAGE_CONCURRENCY = 2;
const POLL_INTERVAL_MS = 1500;
const POLL_TIMEOUT_MS = 90_000;

interface BulkJob {
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
  ) {
    this.model = this.config.get<string>("AGENT_IMAGE_MODEL") ?? DEFAULT_IMAGE_MODEL;
  }

  get configured(): boolean {
    return !!this.config.get<string>("REPLICATE_API_TOKEN");
  }

  /** Generate + store one item's photo inline. Returns the stored data URL. */
  async generateForItem(
    tenantId: string,
    itemId: string,
    styleHint?: string,
  ): Promise<{ ok: boolean; itemId: string; error?: string }> {
    if (!this.configured) {
      return { ok: false, itemId, error: "Image generation needs REPLICATE_API_TOKEN set in the environment." };
    }
    const item = await (this.prisma as any).menuItem.findFirst({
      where: { id: itemId, brand: { tenantId } },
      select: { id: true, name: true, description: true },
    });
    if (!item) return { ok: false, itemId, error: "Item not found for this business." };

    const dataUrl = await this.renderImage(item.name, item.description, styleHint);
    await this.menus.updateItem(itemId, tenantId, { imageUrl: dataUrl } as any);
    return { ok: true, itemId };
  }

  /** Start a THROTTLED background job to photograph a whole menu's items. */
  startBulkForMenu(
    tenantId: string,
    menuId: string,
    onlyMissing: boolean,
    styleHint?: string,
  ): { jobId: string } | { error: string } {
    if (!this.configured) {
      return { error: "Image generation needs REPLICATE_API_TOKEN set in the environment." };
    }
    const jobId = `img_${menuId}_${this.bulkJobs.size}`;
    const job: BulkJob = { status: "running", total: 0, done: 0, failed: 0, startedAt: 0 };
    this.bulkJobs.set(jobId, job);
    void this.runBulk(tenantId, menuId, onlyMissing, styleHint, job).catch((e) =>
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
  ) {
    const items = await (this.prisma as any).menuItem.findMany({
      where: {
        menuIds: { has: menuId },
        brand: { tenantId },
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
          const dataUrl = await this.renderImage(it.name, it.description, styleHint);
          await this.menus.updateItem(it.id, tenantId, { imageUrl: dataUrl } as any);
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

  /** Replicate call → poll → download → downscale to a compact webp data URL. */
  private async renderImage(
    name: string,
    description: string | null | undefined,
    styleHint?: string,
  ): Promise<string> {
    const prompt =
      `Professional food photography of "${name}"` +
      (description ? `, ${description}` : "") +
      (styleHint ? `. ${styleHint}` : "") +
      `. Appetising, freshly served, natural soft lighting, shallow depth of field, ` +
      `clean neutral background, 45-degree angle, high detail, realistic, ` +
      `restaurant menu quality. No text, no watermark.`;

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
    const raw = Buffer.from(await res.arrayBuffer());
    // Downscale + webp so the data URL stored on the item stays small.
    const webp = await sharp(raw)
      .resize(1024, 768, { fit: "inside", withoutEnlargement: true })
      .webp({ quality: 74 })
      .toBuffer();
    return `data:image/webp;base64,${webp.toString("base64")}`;
  }
}
