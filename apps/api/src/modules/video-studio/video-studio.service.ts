import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from "@nestjs/common";
import { PrismaService } from "../../infrastructure/database/prisma.service";
import { SupabaseStorageService } from "../uploads/supabase-storage.service";
import { ReplicateProvider } from "./replicate.provider";
import { GeminiVideoProvider } from "./gemini-video.provider";
import type { AuthenticatedUser } from "../auth/interfaces/jwt-payload.interface";

// Generations are keyed by their provider job id in a single column. Gemini
// operation names are prefixed so reconcile knows which provider to poll;
// anything without the prefix is a Replicate prediction (all existing rows).
const GEMINI_PREFIX = "gemini:";

// How long to keep retrying the download of a finished Veo render before
// giving up and refunding. Generous: the render is already paid for, so a
// retry is free to us and a refund is not.
const GEMINI_DOWNLOAD_GIVE_UP_MS = 20 * 60 * 1000;

export interface GenerateVideoDto {
  imageUrl?: string; // video: source photo (required); image: optional reference
  prompt: string; // the marketing description / scene direction
  style?: string; // "cinematic" (default) | "spokesperson" | "product-photo"
  script?: string; // what the spokesperson says (spokesperson style only)
  format?: string; // "landscape" | "vertical" | "square"
  locationId?: string;
  brandId?: string;
}

// An ad "style" = which model to call + how many credits it costs. Everything
// is env-overridable so the model slug / image field / price can be tuned in
// Render without a code deploy.
interface AdStyle {
  id: string;
  label: string;
  // "video" (default) or "image". Image styles produce a photo and reuse the
  // exact same credit/debit/refund + reconcile pipeline.
  kind: "video" | "image";
  // Which backend renders this style. "gemini" = Google's Veo API direct,
  // which is ~67% cheaper than the same family via Replicate. Falls back to
  // Replicate automatically when GEMINI_API_KEY isn't set.
  provider?: "replicate" | "gemini";
  model?: string; // undefined = base VIDEO_STUDIO_MODEL (Wan)
  imageKey?: string; // undefined = provider default ("image"); "" = no image
  // Some image models take the reference as an ARRAY (e.g. nano-banana's
  // image_input: [url]) rather than a single string. When set, a provided
  // reference is passed as [url] under this key (and imageKey is ignored).
  imageArrayKey?: string;
  // Field name the model uses for aspect ratio (e.g. Veo/flux "aspect_ratio").
  aspectKey?: string;
  credits: number;
  audio: boolean; // does the model produce a voiceover / sound?
  needsScript: boolean; // does the UI collect a spoken script?
  // Image styles: the reference sample is optional (text-to-image works with
  // no upload). Video styles require a source photo.
  imageOptional: boolean;
}

// Social formats the UI offers → the aspect-ratio value we pass to the model.
const ASPECT_RATIOS: Record<string, string> = {
  landscape: "16:9",
  vertical: "9:16",
  square: "1:1",
};

function envInt(key: string, fallback: number): number {
  const n = Number(process.env[key]);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

@Injectable()
export class VideoStudioService {
  private readonly logger = new Logger(VideoStudioService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly replicate: ReplicateProvider,
    private readonly gemini: GeminiVideoProvider,
    private readonly storage: SupabaseStorageService,
  ) {}

  /**
   * Which provider actually renders a style. A style may ask for Gemini, but
   * if no key is configured we quietly fall back to Replicate so the feature
   * keeps working (rather than failing the moment this deploys ahead of the
   * env var being set in Render).
   */
  private providerFor(style: AdStyle): "replicate" | "gemini" {
    if (style.provider === "gemini" && this.gemini.isConfigured()) return "gemini";
    return "replicate";
  }

  private db() {
    return this.prisma as any;
  }

  /** The ad styles offered in the UI. Model/price env-overridable. */
  styles(): AdStyle[] {
    return [
      {
        id: "cinematic",
        label: "Cinematic product video",
        kind: "video",
        model: undefined, // base Wan i2v
        imageKey: undefined,
        // Wan i2v output follows the input photo's shape; only honour a format
        // field if one is configured for the base model.
        aspectKey: process.env.VIDEO_STUDIO_CINEMATIC_ASPECT_KEY || undefined,
        credits: envInt("VIDEO_STUDIO_CINEMATIC_CREDITS", 1),
        audio: false,
        needsScript: false,
        imageOptional: false,
      },
      {
        id: "spokesperson",
        label: "Talking spokesperson (voice + sound)",
        kind: "video",
        // Google's Veo API direct: Veo 3.1 Lite at 720p is $0.05/sec — $0.40
        // for an 8s clip, vs $1.20 for the same clip through Replicate's
        // veo-3-fast. The Replicate model below is the fallback when
        // GEMINI_API_KEY isn't set.
        provider: "gemini",
        model: process.env.VIDEO_STUDIO_SPOKESPERSON_MODEL || "google/veo-3-fast",
        // Veo takes a first-frame "image". Set VIDEO_STUDIO_SPOKESPERSON_IMAGE_KEY=""
        // to fall back to pure text-to-video if a model rejects the image field.
        imageKey: process.env.VIDEO_STUDIO_SPOKESPERSON_IMAGE_KEY ?? "image",
        aspectKey: process.env.VIDEO_STUDIO_SPOKESPERSON_ASPECT_KEY ?? "aspect_ratio",
        credits: envInt("VIDEO_STUDIO_SPOKESPERSON_CREDITS", 4),
        audio: true,
        needsScript: true,
        imageOptional: false,
      },
      {
        id: "product-photo",
        label: "Product photo (AI image)",
        kind: "image",
        // Default nano-banana (Gemini image): prompt + optional image_input[].
        // Model/keys env-tunable in case the schema differs (Replicate errors
        // surface on the failed card, same as the video styles).
        model: process.env.VIDEO_STUDIO_IMAGE_MODEL || "google/nano-banana",
        // Reference goes in an ARRAY (image_input) for nano-banana; don't also
        // send a single-image key.
        imageKey: "",
        imageArrayKey: process.env.VIDEO_STUDIO_IMAGE_INPUT_KEY ?? "image_input",
        aspectKey: process.env.VIDEO_STUDIO_IMAGE_ASPECT_KEY ?? "aspect_ratio",
        credits: envInt("VIDEO_STUDIO_IMAGE_CREDITS", 1),
        audio: false,
        needsScript: false,
        imageOptional: true,
      },
    ];
  }

  private styleById(id?: string): AdStyle {
    const styles = this.styles();
    return styles.find((s) => s.id === (id || "cinematic")) ?? styles[0]!;
  }

  /** Build the final model prompt for a style (folds in the spoken script). */
  private buildPrompt(style: AdStyle, scene: string, script?: string): string {
    if (!style.needsScript || !script?.trim()) return scene.trim();
    const line = script.trim();
    return (
      `${scene.trim()}. A friendly presenter speaks directly to camera and ` +
      `enthusiastically says: "${line}". Natural clear voiceover, upbeat ` +
      `background music, appetising food advert, energetic and inviting.`
    );
  }

  async getOrCreateAccount(tenantId: string) {
    const existing = await this.db().videoStudioAccount.findUnique({
      where: { tenantId },
    });
    if (existing) return existing;
    return this.db().videoStudioAccount.create({ data: { tenantId } });
  }

  /** Feature status + balance for the dashboard header/upsell. */
  async getStatus(tenantId: string) {
    const acc = await this.getOrCreateAccount(tenantId);
    return {
      addonActive: acc.addonActive,
      includedMonthly: acc.includedMonthly,
      includedBalance: acc.includedBalance,
      topupBalance: acc.topupBalance,
      balance: acc.includedBalance + acc.topupBalance,
      providerReady: this.replicate.isConfigured() || this.gemini.isConfigured(),
      model: this.replicate.model,
      styles: this.styles().map((s) => ({
        id: s.id,
        label: s.label,
        kind: s.kind,
        credits: s.credits,
        audio: s.audio,
        needsScript: s.needsScript,
        supportsFormat: !!s.aspectKey,
        imageOptional: s.imageOptional,
      })),
    };
  }

  // ── Credit ledger ───────────────────────────────────────────────────────
  private async writeTxn(
    tenantId: string,
    delta: number,
    reason: string,
    opts: { source?: string; generationId?: string; note?: string } = {},
  ) {
    await this.db().videoCreditTxn.create({
      data: {
        tenantId,
        delta,
        reason,
        source: opts.source ?? null,
        generationId: opts.generationId ?? null,
        note: opts.note ?? null,
      },
    });
  }

  // ── Generate ────────────────────────────────────────────────────────────
  async generate(user: AuthenticatedUser, dto: GenerateVideoDto) {
    const style = this.styleById(dto.style);
    const reference = (dto.imageUrl ?? "").trim();
    if (!dto?.prompt?.trim()) {
      throw new BadRequestException("A description is required");
    }
    // Video needs a source photo; image generation's reference is optional.
    if (!style.imageOptional && !reference) {
      throw new BadRequestException("A product photo is required for this style");
    }
    const acc = await this.getOrCreateAccount(user.tenantId);
    if (!acc.addonActive) {
      throw new ForbiddenException(
        "The AI Studio add-on isn't active for this account.",
      );
    }
    const provider = this.providerFor(style);
    if (provider === "replicate" && !this.replicate.isConfigured()) {
      throw new BadRequestException("AI generation isn't configured on the server.");
    }
    if (style.needsScript && !dto.script?.trim()) {
      throw new BadRequestException("Add a short script for the spokesperson to say.");
    }
    const finalPrompt = this.buildPrompt(style, dto.prompt, dto.script);
    const cost = style.credits;
    // Format → aspect ratio, only when the model supports a format field.
    const extra: Record<string, unknown> = {};
    if (style.aspectKey && dto.format && ASPECT_RATIOS[dto.format]) {
      extra[style.aspectKey] = ASPECT_RATIOS[dto.format];
    }
    // Array-style reference input (e.g. nano-banana image_input: [url]).
    if (style.imageArrayKey && reference) {
      extra[style.imageArrayKey] = [reference];
    }

    // Atomic debit BEFORE we ever call the provider — take from the monthly
    // allowance first, then purchased top-ups. The guarded updateMany makes
    // each decrement race-safe (a concurrent request can't push us negative).
    const { gen } = await this.prisma.$transaction(async (tx: any) => {
      let source: string;
      const inc = await tx.videoStudioAccount.updateMany({
        where: { tenantId: user.tenantId, includedBalance: { gte: cost } },
        data: { includedBalance: { decrement: cost } },
      });
      if (inc.count > 0) {
        source = "included";
      } else {
        const top = await tx.videoStudioAccount.updateMany({
          where: { tenantId: user.tenantId, topupBalance: { gte: cost } },
          data: { topupBalance: { decrement: cost } },
        });
        if (top.count === 0) {
          throw new BadRequestException(
            "You're out of credits — top up or wait for your monthly reset.",
          );
        }
        source = "topup";
      }
      const gen = await tx.videoGeneration.create({
        data: {
          tenantId: user.tenantId,
          userId: user.userId,
          locationId: dto.locationId ?? null,
          brandId: dto.brandId ?? null,
          status: "QUEUED",
          kind: style.kind === "image" ? "IMAGE" : "VIDEO",
          model:
            provider === "gemini"
              ? this.gemini.model
              : style.model || this.replicate.model,
          prompt: finalPrompt,
          sourceImageUrl: reference,
          creditsCost: cost,
        },
      });
      await tx.videoCreditTxn.create({
        data: {
          tenantId: user.tenantId,
          delta: -cost,
          reason: "DEBIT",
          source,
          generationId: gen.id,
        },
      });
      return { gen };
    });

    // Kick off the render. If the provider rejects the request, refund now.
    try {
      let jobId: string;
      if (provider === "gemini") {
        const op = await this.gemini.createOperation({
          image: reference || undefined,
          prompt: finalPrompt,
          aspectRatio: dto.format ? ASPECT_RATIOS[dto.format] : undefined,
        });
        jobId = `${GEMINI_PREFIX}${op.id}`;
      } else {
        const prediction = await this.replicate.createPrediction({
          image: reference || undefined,
          prompt: finalPrompt,
          model: style.model,
          imageKey: style.imageKey,
          extra,
        });
        jobId = prediction.id;
      }
      return this.db().videoGeneration.update({
        where: { id: gen.id },
        data: { status: "RENDERING", replicatePredictionId: jobId },
      });
    } catch (err: any) {
      this.logger.error(`${provider} create failed for gen ${gen.id}: ${err?.message}`);
      await this.failAndRefund(gen, err?.message ?? "provider rejected the request");
      throw new BadRequestException(
        "Couldn't start the render — your credit was refunded. Please try again.",
      );
    }
  }

  // ── Reconcile (called by the cron) ───────────────────────────────────────
  async reconcile(): Promise<void> {
    if (!this.replicate.isConfigured() && !this.gemini.isConfigured()) return;
    const pending = await this.db().videoGeneration.findMany({
      where: { status: "RENDERING", replicatePredictionId: { not: null } },
      orderBy: { createdAt: "asc" },
      take: 25,
    });
    for (const gen of pending) {
      try {
        const jobId: string = gen.replicatePredictionId;
        if (jobId.startsWith(GEMINI_PREFIX)) {
          await this.reconcileGemini(gen, jobId.slice(GEMINI_PREFIX.length));
          continue;
        }
        const pred = await this.replicate.getPrediction(jobId);
        if (pred.status === "succeeded") {
          const url = this.replicate.outputUrl(pred.output);
          if (!url) {
            await this.failAndRefund(gen, "finished but produced no output");
            continue;
          }
          const finalUrl = await this.persist(url, gen.kind);
          await this.db().videoGeneration.update({
            where: { id: gen.id },
            data: { status: "READY", resultUrl: finalUrl },
          });
        } else if (pred.status === "failed" || pred.status === "canceled") {
          await this.failAndRefund(gen, pred.error ?? `render ${pred.status}`);
        }
        // starting/processing → leave RENDERING; picked up next tick.
      } catch (err: any) {
        // Transient poll error — leave it RENDERING and retry next tick. Only a
        // terminal provider state (failed/canceled) triggers a refund.
        this.logger.warn(`reconcile poll error for gen ${gen.id}: ${err?.message}`);
      }
    }
  }

  /** Poll one in-flight Gemini (Veo) operation and finalise it. */
  private async reconcileGemini(gen: any, operationName: string): Promise<void> {
    const op = await this.gemini.getOperation(operationName);
    if (!op.done) return; // still rendering — next tick.
    if (op.error || !op.videoUri) {
      await this.failAndRefund(gen, op.error ?? "finished but produced no output");
      return;
    }
    // Veo's file endpoint needs the API key, so the download has to go through
    // the provider rather than persist()'s plain fetch.
    const finalUrl = await this.persist(op.videoUri, gen.kind, (url) =>
      this.gemini.fetchOutput(url),
    );
    if (finalUrl === op.videoUri) {
      // persist() falls back to the provider URL when storage is unavailable.
      // For Replicate that URL is publicly playable; a Veo file URI is not —
      // it needs the key — so handing it to the browser would look like a
      // successful render that won't play.
      //
      // The video itself exists and Google has already charged for it, so a
      // transient download blip must NOT be terminal: leave the row RENDERING
      // and let the next tick retry (Veo operations stay queryable for ~2
      // days). Only give up once it's clearly not coming back.
      const ageMs = Date.now() - new Date(gen.createdAt).getTime();
      if (ageMs < GEMINI_DOWNLOAD_GIVE_UP_MS) {
        this.logger.warn(
          `gen ${gen.id}: couldn't re-host the Veo output yet — retrying next tick`,
        );
        return;
      }
      this.logger.error(
        `gen ${gen.id}: still couldn't re-host the Veo output after ${Math.round(
          ageMs / 60000,
        )}m — refunding rather than storing an unplayable URI`,
      );
      await this.failAndRefund(gen, "couldn't save the finished video");
      return;
    }
    await this.db().videoGeneration.update({
      where: { id: gen.id },
      data: { status: "READY", resultUrl: finalUrl },
    });
  }

  /** Re-host the provider's (temporary) output to our own storage. */
  private async persist(
    providerUrl: string,
    kind?: string,
    fetcher?: (url: string) => Promise<Response>,
  ): Promise<string> {
    try {
      if (!this.storage.isConfigured()) {
        this.logger.warn("storage isn't configured — keeping the provider URL");
        return providerUrl;
      }
      const res = await (fetcher ? fetcher(providerUrl) : fetch(providerUrl));
      if (!res.ok) {
        // Silently returning here cost a debug cycle: the caller could only
        // report "couldn't re-host", with no status to act on.
        this.logger.warn(
          `download for re-hosting failed ${res.status} ${res.statusText}`,
        );
        return providerUrl;
      }
      const buf = Buffer.from(await res.arrayBuffer());
      const isImage =
        kind === "IMAGE" ||
        (res.headers.get("content-type") || "").startsWith("image/");
      const contentType =
        res.headers.get("content-type") || (isImage ? "image/png" : "video/mp4");
      const ext = isImage
        ? contentType.includes("jpeg") || contentType.includes("jpg")
          ? "jpg"
          : contentType.includes("webp")
            ? "webp"
            : "png"
        : "mp4";
      const folder = isImage ? "image-studio" : "video-studio";
      return await this.storage.uploadBuffer(buf, contentType, folder, ext);
    } catch (err: any) {
      this.logger.warn(`persist to storage failed, keeping provider URL: ${err?.message}`);
      return providerUrl;
    }
  }

  /** Mark a generation FAILED and refund its credit exactly once. */
  private async failAndRefund(gen: any, message: string): Promise<void> {
    await this.prisma.$transaction(async (tx: any) => {
      // Only refund if the row hasn't already left RENDERING/QUEUED — prevents
      // a double refund if two reconcile ticks race the same generation.
      const updated = await tx.videoGeneration.updateMany({
        where: { id: gen.id, status: { in: ["RENDERING", "QUEUED"] } },
        data: { status: "FAILED", error: String(message).slice(0, 500) },
      });
      if (updated.count === 0) return;
      await tx.videoStudioAccount.update({
        where: { tenantId: gen.tenantId },
        data: { includedBalance: { increment: gen.creditsCost } },
      });
      await tx.videoCreditTxn.create({
        data: {
          tenantId: gen.tenantId,
          delta: gen.creditsCost,
          reason: "REFUND",
          generationId: gen.id,
          note: "render failed",
        },
      });
    });
  }

  // ── Reads ────────────────────────────────────────────────────────────────
  async listGenerations(tenantId: string, limit = 30) {
    return this.db().videoGeneration.findMany({
      where: { tenantId },
      orderBy: { createdAt: "desc" },
      take: Math.min(Math.max(limit, 1), 100),
    });
  }

  async getGeneration(id: string, tenantId: string) {
    const gen = await this.db().videoGeneration.findFirst({ where: { id, tenantId } });
    if (!gen) throw new NotFoundException("Generation not found");
    return gen;
  }

  // ── Entitlement + credits (Stripe wiring lands in Phase 2; these are the
  //    hooks the webhook + admin tools call) ───────────────────────────────
  async activateAddon(
    tenantId: string,
    opts: { includedMonthly: number; stripeSubscriptionId?: string },
  ) {
    await this.getOrCreateAccount(tenantId);
    const acc = await this.db().videoStudioAccount.update({
      where: { tenantId },
      data: {
        addonActive: true,
        includedMonthly: opts.includedMonthly,
        includedBalance: opts.includedMonthly, // grant this period's allowance
        lastGrantAt: new Date(),
        ...(opts.stripeSubscriptionId && {
          stripeSubscriptionId: opts.stripeSubscriptionId,
        }),
      },
    });
    await this.writeTxn(tenantId, opts.includedMonthly, "GRANT", {
      note: "add-on activated",
    });
    return acc;
  }

  async deactivateAddon(tenantId: string) {
    return this.db().videoStudioAccount.updateMany({
      where: { tenantId },
      data: { addonActive: false, includedBalance: 0 },
    });
  }

  async topup(tenantId: string, credits: number) {
    if (credits <= 0) throw new BadRequestException("credits must be positive");
    await this.getOrCreateAccount(tenantId);
    const acc = await this.db().videoStudioAccount.update({
      where: { tenantId },
      data: { topupBalance: { increment: credits } },
    });
    await this.writeTxn(tenantId, credits, "TOPUP", { note: "credit pack" });
    return acc;
  }

  /** Reset each active account's monthly allowance (top-ups persist). Run daily
   *  — only grants when the account hasn't been granted this calendar month. */
  async grantMonthly(now: Date): Promise<number> {
    const accounts = await this.db().videoStudioAccount.findMany({
      where: { addonActive: true },
    });
    let granted = 0;
    for (const acc of accounts) {
      const last: Date | null = acc.lastGrantAt;
      const sameMonth =
        last &&
        last.getUTCFullYear() === now.getUTCFullYear() &&
        last.getUTCMonth() === now.getUTCMonth();
      if (sameMonth) continue;
      await this.db().videoStudioAccount.update({
        where: { tenantId: acc.tenantId },
        data: { includedBalance: acc.includedMonthly, lastGrantAt: now },
      });
      await this.writeTxn(acc.tenantId, acc.includedMonthly, "GRANT", {
        note: "monthly reset",
      });
      granted++;
    }
    return granted;
  }
}
