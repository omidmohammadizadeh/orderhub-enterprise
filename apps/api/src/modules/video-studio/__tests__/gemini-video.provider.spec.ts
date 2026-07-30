import { ConfigService } from "@nestjs/config";
import { GeminiVideoProvider } from "../gemini-video.provider";

// The response shape for a finished Veo operation is the one part of this
// integration we can't verify against a live payload without burning a paid
// render, so the extractor is deliberately tolerant. These lock in every shape
// it must handle — a paid generation must never be refunded just because
// Google nested the URI one level deeper than the docs showed.

function provider(env: Record<string, string> = {}) {
  const config = {
    get: (key: string) => env[key],
  } as unknown as ConfigService;
  return new GeminiVideoProvider(config);
}

// extractVideoUri + findFirstUri are private; exercise them through the
// instance rather than re-implementing the walk in the test.
function extract(p: GeminiVideoProvider, response: unknown): string | null {
  return (p as any).extractVideoUri(response);
}

describe("GeminiVideoProvider", () => {
  const URI = "https://generativelanguage.googleapis.com/v1beta/files/abc:download";

  describe("extractVideoUri", () => {
    const p = provider({ GEMINI_API_KEY: "test-key" });

    it("reads the documented generatedSamples shape", () => {
      expect(
        extract(p, { generatedSamples: [{ video: { uri: URI } }] }),
      ).toBe(URI);
    });

    it("reads the generateVideoResponse-nested shape", () => {
      expect(
        extract(p, {
          generateVideoResponse: { generatedSamples: [{ video: { uri: URI } }] },
        }),
      ).toBe(URI);
    });

    it("reads a `videos` array", () => {
      expect(extract(p, { videos: [{ uri: URI }] })).toBe(URI);
    });

    it("reads a Vertex-style predictions array", () => {
      expect(extract(p, { predictions: [{ video: { uri: URI } }] })).toBe(URI);
    });

    it("falls back to the first http uri found anywhere", () => {
      expect(
        extract(p, { some: { unexpected: { nesting: { uri: URI } } } }),
      ).toBe(URI);
    });

    it("ignores non-http uri values so we don't return a mime type or path", () => {
      expect(extract(p, { thing: { uri: "files/abc" } })).toBeNull();
    });

    it("returns null for an empty or malformed response", () => {
      expect(extract(p, null)).toBeNull();
      expect(extract(p, {})).toBeNull();
      expect(extract(p, { generatedSamples: [] })).toBeNull();
    });
  });

  describe("config", () => {
    it("defaults to the Lite model at 720p — the $0.05/sec tier", () => {
      const p = provider({ GEMINI_API_KEY: "k" });
      expect(p.model).toBe("veo-3.1-lite-generate-preview");
      expect((p as any).resolution).toBe("720p");
      expect((p as any).durationSeconds).toBe("8");
    });

    it("is not configured without a key, so the service falls back to Replicate", () => {
      expect(provider({}).isConfigured()).toBe(false);
      expect(provider({ GEMINI_API_KEY: "k" }).isConfigured()).toBe(true);
    });

    it("accepts GOOGLE_API_KEY as an alias", () => {
      expect(provider({ GOOGLE_API_KEY: "k" }).isConfigured()).toBe(true);
    });

    it("clamps unsupported aspect ratios to landscape (Veo takes only 16:9 / 9:16)", () => {
      const p = provider({ GEMINI_API_KEY: "k" });
      expect((p as any).aspect("9:16")).toBe("9:16");
      expect((p as any).aspect("16:9")).toBe("16:9");
      expect((p as any).aspect("1:1")).toBe("16:9");
      expect((p as any).aspect(undefined)).toBe("16:9");
    });
  });

  describe("getOperation", () => {
    const p = provider({ GEMINI_API_KEY: "test-key" });
    const mockFetch = (payload: unknown) => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        json: async () => payload,
      }) as any;
    };

    afterEach(() => jest.restoreAllMocks());

    it("reports not-done while the render is in flight", async () => {
      mockFetch({ done: false });
      await expect(p.getOperation("models/x/operations/1")).resolves.toEqual({
        done: false,
      });
    });

    it("surfaces a terminal error message", async () => {
      mockFetch({ done: true, error: { message: "quota exceeded" } });
      const res = await p.getOperation("models/x/operations/1");
      expect(res).toMatchObject({ done: true, error: "quota exceeded" });
    });

    it("returns the video uri on success", async () => {
      mockFetch({
        done: true,
        response: { generatedSamples: [{ video: { uri: URI } }] },
      });
      const res = await p.getOperation("models/x/operations/1");
      expect(res).toMatchObject({ done: true, videoUri: URI });
    });

    it("errors (so the credit is refunded) when done but output is missing", async () => {
      mockFetch({ done: true, response: {} });
      const res = await p.getOperation("models/x/operations/1");
      expect(res.done).toBe(true);
      expect(res.videoUri).toBeFalsy();
      expect(res.error).toBeTruthy();
    });
  });
});
