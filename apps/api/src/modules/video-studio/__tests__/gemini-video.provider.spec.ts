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

  describe("createOperation request body", () => {
    const p = provider({ GEMINI_API_KEY: "test-key" });

    afterEach(() => jest.restoreAllMocks());

    /**
     * Route by URL, not call order — with no reference photo the Veo request
     * is the only call made.
     */
    function mockFetches() {
      const calls: Array<{ url: string; init?: any }> = [];
      global.fetch = jest.fn(async (url: any, init?: any) => {
        const href = String(url);
        calls.push({ url: href, init });
        if (href.includes("predictLongRunning")) {
          return { ok: true, json: async () => ({ name: "models/x/operations/1" }) } as any;
        }
        return {
          ok: true,
          headers: { get: () => "image/jpeg" },
          arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
        } as any;
      }) as any;
      return calls;
    }

    const veoCall = (calls: Array<{ url: string; init?: any }>) =>
      calls.find((c) => c.url.includes("predictLongRunning"))!;

    it("sends the image as bytesBase64Encoded, NOT inlineData", async () => {
      // Regression guard: `inlineData` is the generateContent shape and this
      // endpoint rejects it outright with a 400 INVALID_ARGUMENT.
      const calls = mockFetches();
      await p.createOperation({ prompt: "a pizza advert", image: "https://x/y.jpg" });
      const body = JSON.parse(veoCall(calls).init.body);
      const image = body.instances[0].image;
      expect(image).toEqual({
        mimeType: "image/jpeg",
        bytesBase64Encoded: Buffer.from([1, 2, 3]).toString("base64"),
      });
      expect(image.inlineData).toBeUndefined();
      expect(JSON.stringify(body)).not.toContain("inlineData");
    });

    it("sends prompt + parameters and omits image when none is given", async () => {
      const calls = mockFetches();
      await p.createOperation({ prompt: "a pizza advert", aspectRatio: "9:16" });
      const body = JSON.parse(veoCall(calls).init.body);
      expect(body.instances[0]).toEqual({ prompt: "a pizza advert" });
      expect(body.parameters).toEqual({
        aspectRatio: "9:16",
        resolution: "720p",
        durationSeconds: "8",
      });
    });

    it("authenticates with a header, never a query param", async () => {
      const calls = mockFetches();
      await p.createOperation({ prompt: "x" });
      expect(veoCall(calls).url).not.toContain("key=");
      expect(veoCall(calls).init.headers["x-goog-api-key"]).toBe("test-key");
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
