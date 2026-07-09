import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";

// Thin Replicate HTTP client for the Video Studio. Kept deliberately small and
// behind an interface-ish shape so the provider (Replicate today) can be
// swapped for fal.ai / a direct model later without touching the service.
//
// The API token lives ONLY in the environment (REPLICATE_API_TOKEN) — never in
// the codebase. Model slug + input tuning are env-driven so we can change
// model/quality without a deploy.

const API_BASE = "https://api.replicate.com/v1";

export interface CreatePredictionResult {
  id: string;
  status: string;
}

export interface PredictionStatus {
  id: string;
  status: "starting" | "processing" | "succeeded" | "failed" | "canceled" | string;
  output: unknown; // string URL or string[] depending on the model
  error?: string | null;
}

@Injectable()
export class ReplicateProvider {
  private readonly logger = new Logger(ReplicateProvider.name);
  private readonly token?: string;
  // Confirmed on Replicate: wan-video/wan-2.2-i2v-fast is the cheapest/fastest
  // image-to-video model and takes `image` + `prompt`. All env-overridable so
  // we can switch models (or adapt a model with a different image key / a
  // pinned version) without a code change.
  readonly model: string;
  private readonly modelVersion?: string;
  private readonly imageKey: string;

  constructor(private readonly config: ConfigService) {
    this.token = this.config.get<string>("REPLICATE_API_TOKEN") || undefined;
    this.model =
      this.config.get<string>("VIDEO_STUDIO_MODEL") || "wan-video/wan-2.2-i2v-fast";
    // Optional: pin a specific version (community models that aren't callable
    // by bare slug need this — set VIDEO_STUDIO_MODEL_VERSION to the hash).
    this.modelVersion =
      this.config.get<string>("VIDEO_STUDIO_MODEL_VERSION") || undefined;
    // Some models name the start-image differently (start_image /
    // first_frame_image). Default matches Wan.
    this.imageKey = this.config.get<string>("VIDEO_STUDIO_IMAGE_KEY") || "image";
  }

  isConfigured(): boolean {
    return !!this.token;
  }

  private headers() {
    return {
      Authorization: `Bearer ${this.token}`,
      "Content-Type": "application/json",
    };
  }

  /**
   * Kick off an image-to-video render. Uses the official-model predictions
   * endpoint (no version pin needed). `image` is a public URL to the product
   * photo; `prompt` is the marketing description.
   */
  async createPrediction(input: {
    prompt: string;
    image?: string;
    // Override the model slug (e.g. a premium Veo style). Defaults to the base
    // VIDEO_STUDIO_MODEL. When an override is given we always call by slug (the
    // base model's optional version pin only applies to the base model).
    model?: string;
    // Field name for the start image. Defaults to the base image key. Pass an
    // empty string to omit the image entirely (text-to-video models).
    imageKey?: string;
    extra?: Record<string, unknown>;
  }): Promise<CreatePredictionResult> {
    if (!this.token) throw new Error("REPLICATE_API_TOKEN not configured");
    const modelSlug = input.model || this.model;
    const imageKey = input.imageKey ?? this.imageKey;
    const payloadInput: Record<string, unknown> = {
      prompt: input.prompt,
      ...(imageKey && input.image ? { [imageKey]: input.image } : {}),
      ...(input.extra ?? {}),
    };
    // Base model may be pinned to a version; any override model is called by
    // slug (works for official/partner models like Wan and Veo).
    let url: string;
    let body: Record<string, unknown>;
    if (!input.model && this.modelVersion) {
      url = `${API_BASE}/predictions`;
      body = { version: this.modelVersion, input: payloadInput };
    } else {
      const [owner, name] = modelSlug.split("/");
      if (!owner || !name) throw new Error(`Invalid model slug: ${modelSlug}`);
      url = `${API_BASE}/models/${owner}/${name}/predictions`;
      body = { input: payloadInput };
    }
    const res = await fetch(url, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      this.logger.error(`Replicate create failed ${res.status}: ${body.slice(0, 500)}`);
      throw new Error(`Replicate render request failed (${res.status})`);
    }
    const json = (await res.json()) as PredictionStatus;
    return { id: json.id, status: json.status };
  }

  async getPrediction(id: string): Promise<PredictionStatus> {
    if (!this.token) throw new Error("REPLICATE_API_TOKEN not configured");
    const res = await fetch(`${API_BASE}/predictions/${id}`, {
      headers: this.headers(),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`Replicate poll failed (${res.status}): ${body.slice(0, 300)}`);
    }
    return (await res.json()) as PredictionStatus;
  }

  /** Normalise a model's output into a single video URL. */
  outputUrl(output: unknown): string | null {
    if (typeof output === "string") return output;
    if (Array.isArray(output) && output.length) {
      const last = output[output.length - 1];
      if (typeof last === "string") return last;
    }
    return null;
  }
}
