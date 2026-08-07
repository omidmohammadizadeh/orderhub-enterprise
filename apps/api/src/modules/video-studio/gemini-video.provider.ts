import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";

// Direct Gemini (Veo) video provider for the Video Studio.
//
// Why this exists alongside ReplicateProvider: the spokesperson style ran on
// Replicate's `google/veo-3-fast` at $0.15/sec ($1.20 for an 8s clip). Google's
// own API sells Veo 3.1 Lite at 720p for $0.05/sec — the same 8s clip for
// $0.40, a ~67% saving. The other two styles stay on Replicate, where they are
// already cheaper than anything Google offers (wan i2v is $0.05 a clip, and
// nano-banana costs the same either way).
//
// The API key lives ONLY in the environment (GEMINI_API_KEY) — never in the
// codebase, and it is sent as a header, never as a URL query parameter.
//
// Shape reference (ai.google.dev/gemini-api/docs/veo):
//   POST /v1beta/models/{model}:predictLongRunning
//   { instances: [{ prompt, image: { bytesBase64Encoded, mimeType } }],
//     parameters: { aspectRatio, resolution, durationSeconds } }
//   → { name: "models/.../operations/..." }
//   GET /v1beta/{operation name} → { done, response?, error? }

/**
 * Pull the human-readable reason out of a Google API error body.
 *
 * Shape is {"error":{"code":400,"message":"…","status":"INVALID_ARGUMENT"}},
 * but a gateway can return HTML instead, so anything unparseable degrades to
 * a trimmed snippet rather than throwing inside an error path.
 */
function geminiReason(body: string): string {
  if (!body) return "";
  try {
    const parsed = JSON.parse(body);
    const msg = parsed?.error?.message;
    if (typeof msg === "string" && msg.trim()) {
      return ` — ${msg.trim().slice(0, 300)}`;
    }
  } catch {
    /* not JSON; fall through to the snippet below */
  }
  const snippet = body.replace(/\s+/g, " ").trim().slice(0, 200);
  return snippet ? ` — ${snippet}` : "";
}

const API_BASE = "https://generativelanguage.googleapis.com/v1beta";

export interface GeminiOperationStatus {
  done: boolean;
  /** Set when done and successful. */
  videoUri?: string | null;
  /** Set when the operation reported a terminal error. */
  error?: string | null;
}

@Injectable()
export class GeminiVideoProvider {
  private readonly logger = new Logger(GeminiVideoProvider.name);
  private readonly apiKey?: string;
  /** Default: the Lite tier — $0.05/sec at 720p, the cheapest Veo with audio. */
  readonly model: string;
  /** 720p is the $0.05/sec tier; 1080p is $0.08/sec. Pinned deliberately. */
  private readonly resolution: string;
  /**
   * Veo accepts 4 | 6 | 8, and rejects a string: "The value type for
   * `durationSeconds` needs to be a number."
   */
  private readonly durationSeconds: number;

  constructor(private readonly config: ConfigService) {
    this.apiKey =
      this.config.get<string>("GEMINI_API_KEY") ||
      this.config.get<string>("GOOGLE_API_KEY") ||
      undefined;
    this.model =
      this.config.get<string>("VIDEO_STUDIO_GEMINI_MODEL") ||
      "veo-3.1-lite-generate-preview";
    this.resolution =
      this.config.get<string>("VIDEO_STUDIO_GEMINI_RESOLUTION") || "720p";
    const duration = Number(
      this.config.get<string>("VIDEO_STUDIO_GEMINI_DURATION"),
    );
    this.durationSeconds = Number.isFinite(duration) && duration > 0 ? duration : 8;
  }

  isConfigured(): boolean {
    return !!this.apiKey;
  }

  private headers(): Record<string, string> {
    return {
      "x-goog-api-key": this.apiKey as string,
      "Content-Type": "application/json",
    };
  }

  /**
   * Veo only accepts 16:9 and 9:16. Our UI also offers square, which has no
   * Veo equivalent — fall back to landscape rather than sending a value the
   * API will reject.
   */
  private aspect(ratio?: string): string {
    return ratio === "9:16" ? "9:16" : "16:9";
  }

  /**
   * Veo takes the start frame as inline base64, not a URL — so a hosted
   * reference photo has to be pulled down and re-encoded first.
   *
   * predictLongRunning is a `predict`-family endpoint, so the image goes in as
   * { bytesBase64Encoded, mimeType }. The `inlineData` wrapper belongs to
   * generateContent and is rejected here with
   * "`inlineData` isn't supported by this model".
   */
  private async inlineImage(
    url: string,
  ): Promise<{ mimeType: string; bytesBase64Encoded: string }> {
    const res = await fetch(url);
    if (!res.ok) {
      throw new Error(`Couldn't read the product photo (${res.status})`);
    }
    const buf = Buffer.from(await res.arrayBuffer());
    const mimeType = res.headers.get("content-type")?.split(";")[0] || "image/jpeg";
    return { mimeType, bytesBase64Encoded: buf.toString("base64") };
  }

  /**
   * Start a render. Returns the long-running operation name, which is what we
   * poll (and what we persist against the generation row).
   */
  async createOperation(input: {
    prompt: string;
    image?: string;
    aspectRatio?: string;
  }): Promise<{ id: string }> {
    if (!this.apiKey) throw new Error("GEMINI_API_KEY not configured");
    const instance: Record<string, unknown> = { prompt: input.prompt };
    if (input.image) {
      instance.image = await this.inlineImage(input.image);
    }
    const body = {
      instances: [instance],
      parameters: {
        aspectRatio: this.aspect(input.aspectRatio),
        resolution: this.resolution,
        durationSeconds: this.durationSeconds,
      },
    };
    const res = await fetch(
      `${API_BASE}/models/${this.model}:predictLongRunning`,
      { method: "POST", headers: this.headers(), body: JSON.stringify(body) },
    );
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      this.logger.error(`Gemini create failed ${res.status}: ${text.slice(0, 500)}`);
      // Carry Google's own words through to the operator. "(400)" on its own
      // is unactionable, and the real reason is usually something they can
      // fix themselves in one edit — a prompt Veo's safety filters refuse
      // (people, and anything reading as a minor, are common), an aspect
      // ratio the model does not take, or an image it rejects. All of that
      // was going only to the server log.
      throw new Error(
        `Gemini render request failed (${res.status})${geminiReason(text)}`,
      );
    }
    const json = (await res.json()) as { name?: string };
    if (!json?.name) throw new Error("Gemini returned no operation name");
    return { id: json.name };
  }

  async getOperation(name: string): Promise<GeminiOperationStatus> {
    if (!this.apiKey) throw new Error("GEMINI_API_KEY not configured");
    const res = await fetch(`${API_BASE}/${name}`, { headers: this.headers() });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Gemini poll failed (${res.status}): ${text.slice(0, 300)}`);
    }
    const json = (await res.json()) as any;
    if (!json?.done) return { done: false };
    if (json.error) {
      return { done: true, error: json.error?.message ?? "render failed" };
    }
    const uri = this.extractVideoUri(json.response);
    if (!uri) {
      // Don't guess a shape we haven't seen — log enough of the real payload to
      // fix the extractor, and let the caller refund the credit.
      this.logger.error(
        `Gemini operation done but no video URI found: ${JSON.stringify(
          json.response,
        ).slice(0, 800)}`,
      );
      return { done: true, error: "finished but produced no output" };
    }
    return { done: true, videoUri: uri };
  }

  /**
   * The documented shape is generatedSamples[0].video.uri, but the response has
   * been nested under generateVideoResponse in some versions and called
   * `videos` in others. Try the known shapes, then fall back to the first uri
   * found anywhere in the payload rather than failing a paid render on a
   * cosmetic rename.
   */
  private extractVideoUri(response: any): string | null {
    if (!response || typeof response !== "object") return null;
    const roots = [response, response.generateVideoResponse].filter(Boolean);
    for (const root of roots) {
      for (const key of ["generatedSamples", "videos", "predictions"]) {
        const arr = root?.[key];
        if (Array.isArray(arr) && arr.length) {
          const first = arr[0];
          const uri = first?.video?.uri ?? first?.uri ?? first?.gcsUri;
          if (typeof uri === "string" && uri) return uri;
        }
      }
    }
    return this.findFirstUri(response, 0);
  }

  private findFirstUri(node: any, depth: number): string | null {
    if (depth > 6 || !node || typeof node !== "object") return null;
    for (const [key, value] of Object.entries(node)) {
      if (
        (key === "uri" || key === "url") &&
        typeof value === "string" &&
        value.startsWith("http")
      ) {
        return value;
      }
      const nested = this.findFirstUri(value, depth + 1);
      if (nested) return nested;
    }
    return null;
  }

  /**
   * Download a finished render. The file endpoint needs the API key, so the
   * fetch has to happen here rather than in the service's generic persist().
   *
   * Google's own example is `curl -L` — the download URI 302s to a storage
   * host. Redirects are followed by hand so the API key can be DROPPED on the
   * way out of googleapis.com: the storage host doesn't want it, and sending a
   * credential to another origin is wrong regardless of whether it 400s.
   */
  async fetchOutput(uri: string): Promise<Response> {
    if (!this.apiKey) throw new Error("GEMINI_API_KEY not configured");
    let url = uri;
    for (let hop = 0; hop < 5; hop++) {
      const authed = new URL(url).hostname.endsWith("googleapis.com");
      const res = await fetch(url, {
        redirect: "manual",
        headers: authed ? { "x-goog-api-key": this.apiKey } : {},
      });
      if (res.status >= 300 && res.status < 400) {
        const next = res.headers.get("location");
        if (!next) return res;
        url = new URL(next, url).toString();
        continue;
      }
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        this.logger.error(
          `Veo download failed ${res.status} (hop ${hop}, authed=${authed}): ${body.slice(0, 300)}`,
        );
      }
      return res;
    }
    throw new Error("Veo download exceeded the redirect limit");
  }
}
