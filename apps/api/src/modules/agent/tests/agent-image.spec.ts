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
  it("defaults to Gemini, the cheapest of the three per photo", () => {
    const s: any = svc({ GEMINI_API_KEY: "k", OPENAI_API_KEY: "o", REPLICATE_API_TOKEN: "r" });
    expect(s.provider).toBe("gemini");
  });

  it("switches provider by env alone, so comparing quality needs no deploy", () => {
    const s: any = svc({
      GEMINI_API_KEY: "k",
      OPENAI_API_KEY: "o",
      AGENT_IMAGE_PROVIDER: "openai",
    });
    expect(s.provider).toBe("openai");
    expect(s.configured).toBe(true);
  });

  it("falls back through the keys that are actually present", () => {
    expect((svc({ OPENAI_API_KEY: "o" }) as any).provider).toBe("openai");
    expect((svc({ REPLICATE_API_TOKEN: "r" }) as any).provider).toBe("replicate");
  });

  it("reports not-configured when the chosen provider has no key", () => {
    // The dangerous case: forced to openai, but only Gemini's key is set. It
    // must not quietly generate on the other provider — that's a different
    // look and a different bill than the operator asked for.
    const s: any = svc({ GEMINI_API_KEY: "k", AGENT_IMAGE_PROVIDER: "openai" });
    expect(s.configured).toBe(false);
  });

  it("names the provider AND the missing key when it can't generate", async () => {
    const s = svc({ AGENT_IMAGE_PROVIDER: "openai" });
    const res = await s.generateForItem("t1", "i1");
    expect(res.ok).toBe(false);
    expect(res.error).toContain("openai");
    expect(res.error).toContain("OPENAI_API_KEY");
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
