import { AgentImageService } from "../agent-image.service";

// ── Agent image generation ──────────────────────────────────────────────────
//
// The three decisions that cost money or quality if they drift:
//   - which provider is used (Gemini is ~10x cheaper and its key is already
//     on the API, so it should win whenever it's available)
//   - the photo fills the menu card rather than sitting letterboxed in it
//   - the bytes are hosted, not stored on the row
//
// The last one matters more than it looks: a data: URL rides in every payload
// that carries the item, so a 100-item menu would drag ~10MB of base64 around
// on every menu load, POS catalogue fetch and kiosk boot.

const svc = (env: Record<string, string | undefined>) =>
  new AgentImageService(
    { get: (k: string) => env[k] } as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
  );

describe("agent images — provider choice", () => {
  it("prefers Gemini when its key is present", () => {
    const s: any = svc({ GEMINI_API_KEY: "k", REPLICATE_API_TOKEN: "r" });
    expect(s.useGemini).toBe(true);
  });

  it("falls back to Replicate when Gemini has no key", () => {
    const s: any = svc({ REPLICATE_API_TOKEN: "r" });
    expect(s.useGemini).toBe(false);
    expect(s.configured).toBe(true);
  });

  it("can be forced back to Replicate", () => {
    // An escape hatch that doesn't need a deploy to reach.
    const s: any = svc({
      GEMINI_API_KEY: "k",
      REPLICATE_API_TOKEN: "r",
      AGENT_IMAGE_PROVIDER: "replicate",
    });
    expect(s.useGemini).toBe(false);
  });

  it("reports not-configured when neither key is set", () => {
    const s: any = svc({});
    expect(s.configured).toBe(false);
  });

  it("names BOTH keys when it can't generate", async () => {
    // "not configured" sends the operator hunting. Say which env var to set.
    const s = svc({});
    const res = await s.generateForItem("t1", "i1");
    expect(res.ok).toBe(false);
    expect(res.error).toContain("GEMINI_API_KEY");
    expect(res.error).toContain("REPLICATE_API_TOKEN");
  });
});

describe("agent images — the prompt", () => {
  it("puts the description in, because the name is often just a brand", () => {
    // "Filthy Box" describes nothing; the description is the actual dish.
    const s: any = svc({ GEMINI_API_KEY: "k" });
    const p = s.buildPrompt(
      "Filthy Box",
      "chicken, doner, pitta bread and garlic sauce in a 14 inch box with a coke",
    );
    expect(p).toContain("Filthy Box");
    expect(p).toContain("garlic sauce");
    expect(p).toContain("14 inch box");
  });

  it("works from the name alone when there's no description", () => {
    const s: any = svc({ GEMINI_API_KEY: "k" });
    expect(s.buildPrompt("Ribeye Steak", null)).toContain("Ribeye Steak");
  });

  it("passes the operator's style through verbatim", () => {
    // The operator asked for a black seamless background; a paraphrase would
    // give them something else.
    const s: any = svc({ GEMINI_API_KEY: "k" });
    const p = s.buildPrompt("Wrap", "chicken wrap", "pure black seamless background");
    expect(p).toContain("pure black seamless background");
  });

  it("rules out the things that make a photo unusable on a menu", () => {
    const s: any = svc({ GEMINI_API_KEY: "k" });
    const p = s.buildPrompt("Wrap", "chicken wrap");
    expect(p).toContain("No text");
    expect(p).toContain("no people");
  });
});
