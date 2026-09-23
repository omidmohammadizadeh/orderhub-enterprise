import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from "@nestjs/common";
import { PrismaService } from "../../infrastructure/database/prisma.service";
import { SupabaseStorageService } from "../uploads/supabase-storage.service";
import { WalletService } from "../wallet/wallet.service";
import { ReplicateProvider } from "./replicate.provider";
import { GeminiVideoProvider, clampDuration } from "./gemini-video.provider";
import type { AuthenticatedUser } from "../auth/interfaces/jwt-payload.interface";

// Generations are keyed by their provider job id in a single column. Gemini
// operation names are prefixed so reconcile knows which provider to poll;
// anything without the prefix is a Replicate prediction (all existing rows).
const GEMINI_PREFIX = "gemini:";

// How long to keep retrying the download of a finished Veo render before
// giving up and refunding. Generous: the render is already paid for, so a
// retry is free to us and a refund is not.
const GEMINI_DOWNLOAD_GIVE_UP_MS = 20 * 60 * 1000;

// What a render costs US, in USD. Published provider rates, checked
// 2026-09-23 — keep them here rather than in someone's head, because the
// same 8-second spokesperson clip is $0.40 through Google and $1.20 through
// Replicate and nothing in the logs used to say which one ran.
//
//   ai.google.dev/gemini-api/docs/pricing  — Veo 3.1 Lite 720p w/ audio $0.05/s
//   replicate.com/google/veo-3-fast        — with_audio $0.15/s
//
// A model we don't have a rate for costs `null`, which prints as "unknown"
// rather than a confident zero.
const USD_PER_SECOND: Record<string, Record<string, number>> = {
  "veo-3.1-lite-generate-preview": { "720p": 0.05, "1080p": 0.08 },
  "veo-3.1-fast-generate-preview": { "720p": 0.1, "1080p": 0.12, "4k": 0.3 },
  "veo-3.1-generate-preview": { "720p": 0.4, "1080p": 0.4, "4k": 0.6 },
  "google/veo-3-fast": { "720p": 0.15, "1080p": 0.15, "4k": 0.15 },
};

// A render must never quietly cost more than this. Resolution and model are
// env-configurable, so without a ceiling one setting change turns a 40¢ video
// into a $3.20 one and nothing says so until the bill.
const MAX_COST_USD = Number(process.env["AI_STUDIO_MAX_COST_USD"]) || 0.4;

// How long the spoken line takes. Ad delivery runs about 2.75 words a second;
// Veo does NOT slow down to fit, it cuts the sentence off, so this decides the
// clip length rather than merely describing it.
const WORDS_PER_SECOND = 2.75;
/** The longest clip Veo 3.1 Lite will make, and so the longest line it can say. */
export const MAX_SPOKEN_SECONDS = 8;
export function speechSeconds(script: string): number {
  const words = script.trim().split(/\s+/).filter(Boolean).length;
  return words / WORDS_PER_SECOND;
}

/** Flat per-run rates for models not priced by the second. */
const USD_PER_RUN: Record<string, number> = {
  "google/nano-banana": 0.039,
};

function estimateUsd(model: string, seconds: number, resolution = "720p"): number | null {
  const byResolution = USD_PER_SECOND[model];
  if (byResolution) {
    const perSecond = byResolution[resolution] ?? byResolution["720p"];
    if (perSecond !== undefined) return Number((perSecond * seconds).toFixed(3));
  }
  const perRun = USD_PER_RUN[model];
  return perRun !== undefined ? perRun : null;
}

const usd = (n: number | null) => (n === null ? "unknown cost" : `$${n.toFixed(2)}`);

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
    private readonly wallet: WalletService,
  ) {}

  /**
   * Which provider actually renders a style. A style may ask for Gemini, but
   * if no key is configured we quietly fall back to Replicate so the feature
   * keeps working (rather than failing the moment this deploys ahead of the
   * env var being set in Render).
   */
  private providerFor(style: AdStyle): "replicate" | "gemini" {
    if (style.provider === "gemini" && this.gemini.isConfigured()) return "gemini";
    if (style.provider === "gemini") {
      // Falling back is a THREE TIMES price rise ($0.40 → $1.20 for the same
      // 8s clip), and it used to happen in silence — no error, no log, just a
      // bigger bill at the end of the month. Say it every time.
      this.logger.warn(
        `AI Studio: "${style.id}" wants Google Veo direct but GEMINI_API_KEY is not set — ` +
          `falling back to Replicate, which costs about 3x as much per render. ` +
          `Set GEMINI_API_KEY in Render to pay the cheaper rate.`,
      );
    }
    return "replicate";
  }

  /** Seconds of video a style produces — what the per-second rates bill on. */
  private secondsFor(
    style: AdStyle,
    provider: "replicate" | "gemini",
    script?: string,
  ): number {
    if (style.kind === "image") return 0;
    if (provider !== "gemini") return 8;
    // Fit the clip to the line rather than always buying eight seconds: a
    // ten-word script needs four, which costs us half as much. The customer
    // pays the same either way, so this is margin, not a discount.
    if (style.needsScript && script?.trim()) {
      return clampDuration(Math.ceil(speechSeconds(script)));
    }
    return this.gemini.durationSeconds;
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

  /**
   * Feature status + the paying wallet, for the dashboard header.
   *
   * Scoped to a LOCATION: renders are billed to that location's wallet, so the
   * balance and prices shown must be that location's too. A user without
   * access to it gets a 403 here rather than a misleading balance.
   */
  async getStatus(tenantId: string, locationId: string | null, user?: AuthenticatedUser) {
    const acc = await this.getOrCreateAccount(tenantId);
    await this.wallet.assertLocationAccess(tenantId, locationId, user?.userId, user?.role);
    const styles = this.styles();
    const w = await this.wallet.aiStudioPrices(tenantId, locationId, styles.map((s) => s.id));
    return {
      addonActive: acc.addonActive,
      // The wallet that pays for a render here — same balance the SMS and
      // voice features spend, per location.
      locationId,
      balanceMinor: w.balanceMinor,
      currency: w.currency,
      pricesMinor: w.pricesMinor,
      providerReady: this.replicate.isConfigured() || this.gemini.isConfigured(),
      // WHICH renderer is live, not just "one of them is".
      //
      // A style can ask for Google Veo and silently fall back to Replicate
      // when GEMINI_API_KEY is unset, so an operator who believes they are on
      // Google AI Studio gets Replicate renders — and Replicate's output URLs
      // are the ones that expire. Naming the live provider makes that visible
      // instead of something you deduce from a broken video's hostname.
      providers: {
        gemini: this.gemini.isConfigured(),
        replicate: this.replicate.isConfigured(),
      },
      // Without storage a finished video keeps a provider URL that dies
      // within the hour, so the studio looks like it renders fine and then
      // stops playing. Surfaced so that shows as a banner rather than being
      // discovered days later.
      storageReady: this.storage.isConfigured(),
      model: this.replicate.model,
      styles: this.styles().map((s) => ({
        id: s.id,
        label: s.label,
        kind: s.kind,
        // No price here on purpose: what a style costs depends on the
        // LOCATION's wallet, so it's quoted once in pricesMinor above rather
        // than twice in two places that could disagree.
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
    // Veo never speaks faster to fit a long line — it just stops when the clip
    // ends, mid-word. Eight seconds is the model's ceiling, so a script that
    // can't be said in eight seconds is a ruined video we'd have charged for.
    if (style.needsScript && dto.script) {
      const spoken = speechSeconds(dto.script);
      if (spoken > MAX_SPOKEN_SECONDS) {
        const words = dto.script.trim().split(/\s+/).filter(Boolean).length;
        const keep = Math.floor(MAX_SPOKEN_SECONDS * WORDS_PER_SECOND);
        throw new BadRequestException(
          `That script is about ${spoken.toFixed(1)} seconds of speech and the video is ` +
            `${MAX_SPOKEN_SECONDS} seconds long, so the end would be cut off mid-sentence. ` +
            `Trim it to around ${keep} words — it's currently ${words}.`,
        );
      }
    }
    const finalPrompt = this.buildPrompt(style, dto.prompt, dto.script);

    // Which wallet pays — and whether this user may spend from it. A
    // location-scoped user (OWNER, FINANCIAL_AGENT) can only ever charge a
    // location assigned to them, and is refused the tenant-wide wallet
    // outright, so one site can never burn another site's balance.
    const locationId = dto.locationId ?? null;
    await this.wallet.assertLocationAccess(user.tenantId, locationId, user.userId, user.role);
    const walletRow = await this.wallet.getOrCreate(user.tenantId, locationId);
    const cost = this.wallet.aiStudioPriceMinor(walletRow, style.id);
    // Format → aspect ratio, only when the model supports a format field.
    const extra: Record<string, unknown> = {};
    if (style.aspectKey && dto.format && ASPECT_RATIOS[dto.format]) {
      extra[style.aspectKey] = ASPECT_RATIOS[dto.format];
    }
    // Array-style reference input (e.g. nano-banana image_input: [url]).
    if (style.imageArrayKey && reference) {
      extra[style.imageArrayKey] = [reference];
    }

    // Refuse to render anything that would cost US more than the ceiling. The
    // model and resolution are env-configurable, so without this one setting
    // change turns a 40¢ video into a $3.20 one silently — and the customer's
    // price is fixed, so every cent of that comes off the margin.
    const seconds = this.secondsFor(style, provider, dto.script);
    const model =
      provider === "gemini" ? this.gemini.model : style.model || this.replicate.model;
    const estimate = estimateUsd(model, seconds, this.gemini.resolution);
    if (estimate !== null && estimate > MAX_COST_USD + 1e-9) {
      this.logger.error(
        `AI Studio refused "${style.id}": ${model} at ${this.gemini.resolution} for ${seconds}s ` +
          `would cost $${estimate.toFixed(2)}, over the $${MAX_COST_USD.toFixed(2)} ceiling. ` +
          `Change the model/resolution back, or raise AI_STUDIO_MAX_COST_USD deliberately.`,
      );
      throw new BadRequestException(
        "This render is configured in a way that costs more than allowed. It hasn't been charged.",
      );
    }

    // The row exists before the money moves so the wallet statement can name
    // the render it paid for. Nothing has been spent yet at this point.
    const gen = await this.db().videoGeneration.create({
      data: {
        tenantId: user.tenantId,
        userId: user.userId,
        locationId,
        brandId: dto.brandId ?? null,
        status: "QUEUED",
        kind: style.kind === "image" ? "IMAGE" : "VIDEO",
        model:
          provider === "gemini"
            ? this.gemini.model
            : style.model || this.replicate.model,
        prompt: finalPrompt,
        sourceImageUrl: reference,
        chargedMinor: cost,
      },
    });
    // Charged BEFORE the provider is called, and given straight back if the
    // render never starts. debitForAiStudio checks the balance inside the
    // update's WHERE clause, so two renders begun at once can't both spend the
    // same money. An insufficient balance throws here and the row is dropped.
    try {
      await this.wallet.debitForAiStudio({
        tenantId: user.tenantId,
        locationId,
        generationId: gen.id,
        styleLabel: style.label,
        amountMinor: cost,
        createdBy: user.userId,
      });
    } catch (err) {
      await this.db().videoGeneration.delete({ where: { id: gen.id } }).catch(() => undefined);
      throw err;
    }

    // Kick off the render. If the provider rejects the request, refund now.
    try {
      let jobId: string;
      if (provider === "gemini") {
        const op = await this.gemini.createOperation({
          image: reference || undefined,
          prompt: finalPrompt,
          aspectRatio: dto.format ? ASPECT_RATIOS[dto.format] : undefined,
          durationSeconds: seconds,
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
      // The one line that makes spend auditable after the fact: which provider
      // actually served it, on what model, and what that bills us.
      this.logger.log(
        `AI Studio render ${gen.id}: style=${style.id} provider=${provider} model=${gen.model}` +
          (seconds ? ` ${seconds}s` : "") +
          ` — costs us ${usd(estimate)}, charged ${cost} credit${cost === 1 ? "" : "s"}` +
          ` (tenant ${user.tenantId})`,
      );
      return this.db().videoGeneration.update({
        where: { id: gen.id },
        data: { status: "RENDERING", replicatePredictionId: jobId },
      });
    } catch (err: any) {
      this.logger.error(`${provider} create failed for gen ${gen.id}: ${err?.message}`);
      await this.failAndRefund(gen, err?.message ?? "provider rejected the request");
      throw new BadRequestException(
        "Couldn't start the render — the charge was refunded to your wallet. Please try again.",
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
          const saved = await this.persist(url, gen.kind);
          const finalUrl = saved.url;
          // Storage being switched off is the operator's problem and no amount
          // of retrying fixes it — a short-lived URL beats nobody ever getting
          // a video. Only a transient failure is worth retrying then refunding.
          if (!saved.rehosted && saved.reason !== "not-configured") {
            // persist() falls back to the provider URL when re-hosting fails.
            // A replicate.delivery link is publicly playable — for about an
            // hour. Storing one as a finished creation gives a video that
            // works when you generate it and is a dead black box the next
            // day, which is worse than a render that visibly failed.
            //
            // Same policy the Veo path already applies: the output exists and
            // has been paid for, so a download blip must not be terminal —
            // leave it RENDERING and retry next tick, give up only once it is
            // clearly not coming back.
            const ageMs = Date.now() - new Date(gen.createdAt).getTime();
            if (ageMs < GEMINI_DOWNLOAD_GIVE_UP_MS) {
              this.logger.warn(
                `gen ${gen.id}: couldn't re-host the Replicate output yet — retrying next tick`,
              );
              continue;
            }
            this.logger.error(
              `gen ${gen.id}: still couldn't re-host the Replicate output after ${Math.round(
                ageMs / 60000,
              )}m — refunding rather than storing a URL that will expire`,
            );
            await this.failAndRefund(
              gen,
              saved.detail ?? "couldn't save the finished video",
            );
            continue;
          }
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
    const saved = await this.persist(op.videoUri, gen.kind, (url) =>
      this.gemini.fetchOutput(url),
    );
    const finalUrl = saved.url;
    // Unlike Replicate, a Veo file URI needs our API key, so it is unplayable
    // in a browser however fresh it is. There is no useful fallback: if we
    // could not re-host it, there is nothing to hand over.
    if (!saved.rehosted) {
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
      await this.failAndRefund(
        gen,
        saved.detail ?? "couldn't save the finished video",
      );
      return;
    }
    await this.db().videoGeneration.update({
      where: { id: gen.id },
      data: { status: "READY", resultUrl: finalUrl },
    });
  }

  /**
   * Re-host the provider's (temporary) output to our own storage.
   *
   * Reports WHY it fell back, because the two reasons need opposite handling.
   * "not-configured" is an operator problem no amount of retrying will fix —
   * refusing the render there would mean nobody ever gets a video, so the
   * short-lived provider URL is better than nothing. A failed download or
   * upload is transient and worth retrying, then refunding.
   */
  private async persist(
    providerUrl: string,
    kind?: string,
    fetcher?: (url: string) => Promise<Response>,
  ): Promise<{
    url: string;
    rehosted: boolean;
    reason?: string;
    detail?: string;
  }> {
    try {
      if (!this.storage.isConfigured()) {
        this.logger.error(
          "VIDEO STUDIO: Supabase storage is NOT configured — videos keep a provider URL that expires within the hour. Set SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY and SUPABASE_STORAGE_BUCKET.",
        );
        return {
          url: providerUrl,
          rehosted: false,
          reason: "not-configured",
          detail: "file storage isn't configured",
        };
      }
      const res = await (fetcher ? fetcher(providerUrl) : fetch(providerUrl));
      if (!res.ok) {
        // Silently returning here cost a debug cycle: the caller could only
        // report "couldn't re-host", with no status to act on.
        this.logger.warn(
          `download for re-hosting failed ${res.status} ${res.statusText}`,
        );
        return {
          url: providerUrl,
          rehosted: false,
          reason: "download-failed",
          detail: `couldn't download the render (${res.status} ${res.statusText})`,
        };
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
      const stored = await this.storage.uploadBuffer(buf, contentType, folder, ext);
      return { url: stored, rehosted: true };
    } catch (err: any) {
      // The likeliest cause by far is the bucket rejecting the file: a bucket
      // created for menu images may restrict allowed MIME types to image/*, or
      // cap file size below a 10-second video. Both surface here, and both
      // read as "the video won't play" to whoever generated it.
      this.logger.error(
        `VIDEO STUDIO: re-hosting failed — ${err?.message}. Check the Supabase bucket allows video/mp4 and is large enough.`,
      );
      return {
        url: providerUrl,
        rehosted: false,
        reason: "upload-failed",
        detail: `couldn't store the file — ${err?.message ?? "unknown error"}`,
      };
    }
  }

  /**
   * End-to-end check of the thing that has been failing silently: can we
   * upload an mp4 and read it back publicly?
   */
  async storageCheck() {
    const video = await this.storage.selfTest("video/mp4", "mp4");
    const image = await this.storage.selfTest("image/png", "png");
    return {
      bucket: this.storage.bucketName(),
      video,
      image,
      // The most common shape of this failure: a bucket set up for menu
      // images accepts png and rejects mp4, so images work, videos vanish,
      // and nothing says why.
      likelyCause:
        !video.ok && image.ok
          ? "The bucket accepts images but not video/mp4 — check its Allowed MIME types and file size limit in Supabase."
          : !video.ok && !image.ok
            ? video.error
            : null,
    };
  }

  /** Mark a generation FAILED and refund its credit exactly once. */
  private async failAndRefund(gen: any, message: string): Promise<void> {
    // Claim the row FIRST. Only the caller that actually moves it out of
    // RENDERING/QUEUED refunds, so two reconcile ticks racing the same
    // generation can't hand the money back twice.
    const updated = await this.db().videoGeneration.updateMany({
      where: { id: gen.id, status: { in: ["RENDERING", "QUEUED"] } },
      data: { status: "FAILED", error: String(message).slice(0, 500) },
    });
    if (updated.count === 0) return;
    await this.wallet.refundAiStudio({
      tenantId: gen.tenantId,
      locationId: gen.locationId ?? null,
      generationId: gen.id,
      // What was taken, not what it would cost today — the price list can
      // change between the debit and the failure.
      amountMinor: Number(gen.chargedMinor ?? 0),
      reason: "render failed",
    });
  }

  /**
   * Cancel a stuck or unwanted generation and refund the credit.
   *
   * The provider job is left to finish on its own — we can't un-bill a render
   * that's already running, and abandoning the row is what the operator
   * actually wants (the card stops saying "Rendering…" forever). Reuses
   * failAndRefund so the refund can't double-apply if reconcile lands at the
   * same moment.
   */
  async cancelGeneration(id: string, tenantId: string) {
    const gen = await this.getGeneration(id, tenantId);
    if (!["QUEUED", "RENDERING"].includes(String(gen.status))) {
      throw new BadRequestException(
        "That generation has already finished — nothing to cancel.",
      );
    }
    await this.failAndRefund(gen, "cancelled");
    return this.getGeneration(id, tenantId);
  }

  // ── Reads ────────────────────────────────────────────────────────────────
  async listGenerations(tenantId: string, limit = 30) {
    const rows = await this.db().videoGeneration.findMany({
      where: { tenantId },
      orderBy: { createdAt: "desc" },
      take: Math.min(Math.max(limit, 1), 100),
    });
    // Derived, not stored: the model column already says which provider ran,
    // so what a render cost us is recoverable for every row ever written —
    // including the ones from before this existed. No migration, no backfill.
    return rows.map((g: any) => ({
      ...g,
      provider: g.model?.startsWith("veo-") ? "gemini" : "replicate",
      estCostUsd: estimateUsd(
        g.model,
        g.kind === "IMAGE" ? 0 : this.gemini.durationSeconds,
      ),
    }));
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

  // `topup` is gone on purpose: renders are paid for from the location's
  // wallet now, so the only way to add funds is the wallet's own Stripe
  // top-up. A second pot of money that buys nothing is worse than none.

  /**
   * Formerly the monthly credit grant. Renders are billed from the location's
   * wallet now, so there is no allowance to reset — granting credits nobody
   * can spend would tell an operator they had free renders they don't.
   *
   * Kept as a no-op rather than deleted so the daily cron keeps its shape; if
   * bundled renders come back, they belong here as a wallet grant.
   */
  async grantMonthly(_now: Date): Promise<number> {
    return 0;
  }
}
