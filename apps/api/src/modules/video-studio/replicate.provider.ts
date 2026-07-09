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
  // Default to Wan 2.2 image-to-video (fast) — cheapest solid option. Override
  // with VIDEO_STUDIO_MODEL="owner/name" once the exact slug is confirmed.
  readonly model: string;

  constructor(private readonly config: ConfigService) {
    this.token = this.config.get<string>("REPLICATE_API_TOKEN") || undefined;
    this.model =
      this.config.get<string>("VIDEO_STUDIO_MODEL") || "wan-video/wan-2.2-i2v-fast";
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
    image: string;
    prompt: string;
    extra?: Record<string, unknown>;
  }): Promise<CreatePredictionResult> {
    if (!this.token) throw new Error("REPLICATE_API_TOKEN not configured");
    const [owner, name] = this.model.split("/");
    if (!owner || !name) throw new Error(`Invalid VIDEO_STUDIO_MODEL: ${this.model}`);

    const res = await fetch(`${API_BASE}/models/${owner}/${name}/predictions`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({
        input: { image: input.image, prompt: input.prompt, ...(input.extra ?? {}) },
      }),
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
