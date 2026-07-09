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
import type { AuthenticatedUser } from "../auth/interfaces/jwt-payload.interface";

export interface GenerateVideoDto {
  imageUrl: string; // public URL (or data URI) of the product photo
  prompt: string; // the marketing description / scene direction
  style?: string; // "cinematic" (default) | "spokesperson"
  script?: string; // what the spokesperson says (spokesperson style only)
  locationId?: string;
  brandId?: string;
}

// An ad "style" = which model to call + how many credits it costs. Everything
// is env-overridable so the model slug / image field / price can be tuned in
// Render without a code deploy.
interface AdStyle {
  id: string;
  label: string;
  model?: string; // undefined = base VIDEO_STUDIO_MODEL (Wan)
  imageKey?: string; // undefined = provider default ("image"); "" = no image
  credits: number;
  audio: boolean; // does the model produce a voiceover / sound?
  needsScript: boolean; // does the UI collect a spoken script?
}

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
    private readonly storage: SupabaseStorageService,
  ) {}

  private db() {
    return this.prisma as any;
  }

  /** The ad styles offered in the UI. Model/price env-overridable. */
  styles(): AdStyle[] {
    return [
      {
        id: "cinematic",
        label: "Cinematic product video",
        model: undefined, // base Wan i2v
        imageKey: undefined,
        credits: envInt("VIDEO_STUDIO_CINEMATIC_CREDITS", 1),
        audio: false,
        needsScript: false,
      },
      {
        id: "spokesperson",
        label: "Talking spokesperson (voice + sound)",
        model: process.env.VIDEO_STUDIO_SPOKESPERSON_MODEL || "google/veo-3-fast",
        // Veo takes a first-frame "image". Set VIDEO_STUDIO_SPOKESPERSON_IMAGE_KEY=""
        // to fall back to pure text-to-video if a model rejects the image field.
        imageKey: process.env.VIDEO_STUDIO_SPOKESPERSON_IMAGE_KEY ?? "image",
        credits: envInt("VIDEO_STUDIO_SPOKESPERSON_CREDITS", 4),
        audio: true,
        needsScript: true,
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
      providerReady: this.replicate.isConfigured(),
      model: this.replicate.model,
      styles: this.styles().map((s) => ({
        id: s.id,
        label: s.label,
        credits: s.credits,
        audio: s.audio,
        needsScript: s.needsScript,
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
    if (!dto?.imageUrl || !dto?.prompt) {
      throw new BadRequestException("A product image and description are required");
    }
    const acc = await this.getOrCreateAccount(user.tenantId);
    if (!acc.addonActive) {
      throw new ForbiddenException(
        "The AI Video Studio add-on isn't active for this account.",
      );
    }
    if (!this.replicate.isConfigured()) {
      throw new BadRequestException("Video generation isn't configured on the server.");
    }
    const style = this.styleById(dto.style);
    if (style.needsScript && !dto.script?.trim()) {
      throw new BadRequestException("Add a short script for the spokesperson to say.");
    }
    const finalPrompt = this.buildPrompt(style, dto.prompt, dto.script);
    const cost = style.credits;

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
            "You're out of video credits — top up or wait for your monthly reset.",
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
          model: style.model || this.replicate.model,
          prompt: finalPrompt,
          sourceImageUrl: dto.imageUrl,
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

    // Kick off the render. If Replicate rejects the request, refund immediately.
    try {
      const prediction = await this.replicate.createPrediction({
        image: dto.imageUrl,
        prompt: finalPrompt,
        model: style.model,
        imageKey: style.imageKey,
      });
      return this.db().videoGeneration.update({
        where: { id: gen.id },
        data: { status: "RENDERING", replicatePredictionId: prediction.id },
      });
    } catch (err: any) {
      this.logger.error(`Replicate create failed for gen ${gen.id}: ${err?.message}`);
      await this.failAndRefund(gen, err?.message ?? "provider rejected the request");
      throw new BadRequestException(
        "Couldn't start the video render — your credit was refunded. Please try again.",
      );
    }
  }

  // ── Reconcile (called by the cron) ───────────────────────────────────────
  async reconcile(): Promise<void> {
    if (!this.replicate.isConfigured()) return;
    const pending = await this.db().videoGeneration.findMany({
      where: { status: "RENDERING", replicatePredictionId: { not: null } },
      orderBy: { createdAt: "asc" },
      take: 25,
    });
    for (const gen of pending) {
      try {
        const pred = await this.replicate.getPrediction(gen.replicatePredictionId);
        if (pred.status === "succeeded") {
          const url = this.replicate.outputUrl(pred.output);
          if (!url) {
            await this.failAndRefund(gen, "render finished but produced no video");
            continue;
          }
          const finalUrl = await this.persist(url);
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

  /** Re-host the provider's (temporary) output to our own storage. */
  private async persist(providerUrl: string): Promise<string> {
    try {
      if (!this.storage.isConfigured()) return providerUrl;
      const res = await fetch(providerUrl);
      if (!res.ok) return providerUrl;
      const buf = Buffer.from(await res.arrayBuffer());
      const contentType = res.headers.get("content-type") || "video/mp4";
      return await this.storage.uploadBuffer(buf, contentType, "video-studio", "mp4");
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
