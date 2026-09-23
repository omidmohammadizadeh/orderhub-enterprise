// What a render costs us should never be a mystery.
//
// The spokesperson style asks for Google's Veo API directly — $0.05/sec, so
// $0.40 for the 8-second clip we generate. Without GEMINI_API_KEY it falls
// back to the same family via Replicate at $0.15/sec: $1.20 for an identical
// video. That fallback used to happen in complete silence — no error, no log
// line, nothing in the row to distinguish the two — so the only symptom was a
// bill three times larger than anyone expected.
//
// These pin the two things that make it visible: the fallback announces
// itself, and finished work can be priced from what was actually stored.

import { VideoStudioService } from "../video-studio.service";

function makeService(geminiConfigured: boolean) {
  const warnings: string[] = [];
  const svc = Object.create(VideoStudioService.prototype) as any;
  svc.logger = { log() {}, warn: (m: string) => warnings.push(m), error() {} };
  svc.gemini = { isConfigured: () => geminiConfigured, model: "veo-3.1-lite-generate-preview", durationSeconds: 8 };
  svc.replicate = { isConfigured: () => true, model: "wan-video/wan-2.2-i2v-fast" };
  return { svc, warnings };
}

const spokesperson = (svc: any) => svc.styles().find((s: any) => s.id === "spokesperson");

describe("AI Studio — what a render costs us", () => {
  it("uses Google direct when the key is there, and says nothing alarming", () => {
    const { svc, warnings } = makeService(true);
    expect(svc.providerFor(spokesperson(svc))).toBe("gemini");
    expect(warnings).toHaveLength(0);
  });

  it("warns every time it falls back to the 3x-pricier route", () => {
    const { svc, warnings } = makeService(false);
    expect(svc.providerFor(spokesperson(svc))).toBe("replicate");
    expect(warnings[0]).toMatch(/GEMINI_API_KEY/);
    expect(warnings[0]).toMatch(/3x/i);

    // Every render, not just the first — a one-off warning scrolls away and
    // the overspend carries on.
    svc.providerFor(spokesperson(svc));
    expect(warnings).toHaveLength(2);
  });

  it("bills video by the second and images by the run", () => {
    const { svc } = makeService(true);
    expect(svc.secondsFor(spokesperson(svc), "gemini")).toBe(8);
    const image = svc.styles().find((s: any) => s.id === "product-photo");
    expect(svc.secondsFor(image, "replicate")).toBe(0);
  });

  it("prices past generations from the model that was stored", async () => {
    const { svc } = makeService(true);
    svc.prisma = {
      videoGeneration: {
        findMany: async () => [
          { id: "a", kind: "VIDEO", model: "veo-3.1-lite-generate-preview" },
          { id: "b", kind: "VIDEO", model: "google/veo-3-fast" },
          { id: "c", kind: "IMAGE", model: "google/nano-banana" },
          { id: "d", kind: "VIDEO", model: "some/model-we-never-priced" },
        ],
      },
    };
    const rows = await svc.listGenerations("t1");
    expect(rows.map((r: any) => [r.provider, r.estCostUsd])).toEqual([
      ["gemini", 0.4],
      ["replicate", 1.2],
      ["replicate", 0.039],
      // Unknown beats a confident zero: nobody should read "free" off a model
      // whose rate we never wrote down.
      ["replicate", null],
    ]);
  });
});
