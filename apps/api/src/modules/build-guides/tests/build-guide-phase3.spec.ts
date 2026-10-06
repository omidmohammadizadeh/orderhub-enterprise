import { BuildGuideTrainingService } from "../build-guide-training.service";
import { BuildStepLibraryService } from "../build-step-library.service";
import { BuildGuideAiService } from "../build-guide-ai.service";

const T0 = new Date("2026-10-01T10:00:00Z");
const T1 = new Date("2026-10-02T10:00:00Z");
const T2 = new Date("2026-10-03T10:00:00Z");

describe("training mode", () => {
  const guides = [
    {
      id: "g1", tenantId: "t1", brandId: "b1", name: "Chicken Burrito", nameKey: "chicken burrito",
      steps: [{ id: "s1", text: "Roll", imageUrl: "https://x/step.jpg" }], packNote: null, updatedAt: T1,
      brand: { name: "Fiesta" },
      trainings: [
        { userId: "u-me", completedAt: T2 },  // after the last edit → trained
        { userId: "u-old", completedAt: T0 }, // before it → refresher, not counted
      ],
    },
    {
      id: "g2", tenantId: "t1", brandId: "b1", name: "Nachos", nameKey: "nachos",
      steps: [], packNote: null, updatedAt: T1, brand: { name: "Fiesta" },
      trainings: [{ userId: "u-me", completedAt: T0 }],
    },
  ];
  const prisma: any = {
    buildGuide: {
      findMany: async () => guides,
      findFirst: async ({ where }: any) => guides.find((g) => g.id === where.id && g.tenantId === where.tenantId) ?? null,
    },
    menuItem: { findMany: async () => [{ brandId: "b1", name: "Chicken  Burrito", imageUrl: "https://x/product.jpg" }] },
    buildGuideTraining: {
      upserts: [] as any[],
      upsert: async (args: any) => prisma.buildGuideTraining.upserts.push(args),
      findMany: async () => guides[0]!.trainings,
    },
    user: {
      findMany: async () => [
        { id: "u-me", firstName: "Ana", lastName: "Silva" },
        { id: "u-old", firstName: "Ben", lastName: "" },
      ],
    },
  };
  const svc = new BuildGuideTrainingService(prisma);

  it("reports my status per guide and counts only up-to-date completions", async () => {
    const rows = await svc.overview("t1", "u-me");
    expect(rows[0]).toMatchObject({ id: "g1", myStatus: "trained", trainedCount: 1, imageUrl: "https://x/product.jpg", stepCount: 1 });
    expect(rows[1]).toMatchObject({ id: "g2", myStatus: "refresher", trainedCount: 0 });
    expect((await svc.overview("t1", "u-new"))[0]!.myStatus).toBe("new");
  });

  it("records a completion for the caller only within their tenant", async () => {
    await svc.complete("g1", "t1", "u-me");
    expect(prisma.buildGuideTraining.upserts[0].where).toEqual({ guideId_userId: { guideId: "g1", userId: "u-me" } });
    await expect(svc.complete("g1", "t2", "u-me")).rejects.toThrow("Guide not found");
  });

  it("lists who trained, flagging stale completions", async () => {
    const who = await svc.whoTrained("g1", "t1");
    expect(who).toEqual([
      expect.objectContaining({ name: "Ana Silva", current: true }),
      expect.objectContaining({ name: "Ben", current: false }),
    ]);
  });
});

describe("step library", () => {
  it("saves a cleaned step, drops a foreign brand, refuses an empty one", async () => {
    const created: any[] = [];
    const prisma: any = {
      brand: { findFirst: async ({ where }: any) => (where.id === "b1" && where.tenantId === "t1" ? { id: "b1" } : null) },
      buildStepTemplate: { create: async ({ data }: any) => (created.push(data), data) },
    };
    const svc = new BuildStepLibraryService(prisma);
    await svc.create("t1", { text: "  Wrap in foil, seam down ", tools: ["Foil", "Foil", ""], brandId: "b-other" });
    expect(created[0]).toMatchObject({ tenantId: "t1", brandId: null, text: "Wrap in foil, seam down", title: "Wrap in foil, seam down", tools: ["Foil"] });
    await expect(svc.create("t1", { text: " " })).rejects.toThrow();
  });
});

describe("AI draft", () => {
  const prisma: any = {
    menuItem: {
      findUnique: async () => ({
        id: "i1", brandId: "b1", name: "Loaded Fries", description: null, imageUrl: "https://x/p.jpg",
        modifierGroupLinks: [{ group: { name: "Extras", options: [{ name: "Extra Cheese" }, { name: "No Onion" }] } }],
      }),
    },
    brand: { findFirst: async ({ where }: any) => (where.tenantId === "t1" ? { name: "Fiesta" } : null) },
  };
  const config: any = { get: (k: string) => (k === "ANTHROPIC_API_KEY" ? "test" : undefined) };

  it("returns cleaned steps from the tool call and sends the modifiers in the prompt", async () => {
    const svc = new BuildGuideAiService(prisma, config);
    const calls: any[] = [];
    svc.setClientForTests({
      messages: {
        create: async (args: any) => {
          calls.push(args);
          return {
            content: [{
              type: "tool_use",
              input: {
                steps: [
                  { text: "Fry chips 3 min", amount: "1 basket", tools: ["Fryer"] },
                  { text: "Add cheese", onlyWith: ["Extra Cheese"] },
                  { text: "  " },
                ],
                packNote: "Box, sauce on the side",
              },
            }],
          };
        },
      },
    });
    const draft = await svc.draft("i1", "t1");
    expect(draft.steps).toHaveLength(2);
    expect(draft.steps[1]).toMatchObject({ text: "Add cheese", onlyWith: ["Extra Cheese"], skipWith: [] });
    expect(draft.packNote).toBe("Box, sauce on the side");
    const textBlock = calls[0].messages[0].content.find((b: any) => b.type === "text");
    expect(textBlock.text).toContain("Extra Cheese, No Onion");
  });

  it("refuses another tenant's product", async () => {
    const svc = new BuildGuideAiService(prisma, config);
    svc.setClientForTests({ messages: { create: async () => ({ content: [] }) } });
    await expect(svc.draft("i1", "t2")).rejects.toThrow("Menu item not found");
  });
});

describe("guide video", () => {
  const { parseYouTubeId, parseVideoTime, formatVideoTime } = require("@orderhub/shared");
  const { BuildGuidesService } = require("../build-guides.service");

  it("reads every common YouTube link form", () => {
    for (const u of [
      "https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=30s",
      "youtu.be/dQw4w9WgXcQ?si=abc",
      "https://youtube.com/shorts/dQw4w9WgXcQ",
      "https://m.youtube.com/watch?v=dQw4w9WgXcQ",
      "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ",
      "dQw4w9WgXcQ",
    ]) expect(parseYouTubeId(u)).toBe("dQw4w9WgXcQ");
    expect(parseYouTubeId("https://vimeo.com/123")).toBeNull();
    expect(parseYouTubeId("https://evil.com/watch?v=dQw4w9WgXcQ")).toBeNull();
  });

  it("parses and formats start times", () => {
    expect(parseVideoTime("1:05")).toBe(65);
    expect(parseVideoTime("65")).toBe(65);
    expect(parseVideoTime("1m5s")).toBe(65);
    expect(parseVideoTime("0:01:05")).toBe(65);
    expect(parseVideoTime("soon")).toBeNull();
    expect(formatVideoTime(65)).toBe("1:05");
  });

  function svcWith(rows: any[]) {
    const prisma: any = {
      menuItem: { findUnique: async () => ({ id: "i1", brandId: "b1", name: "Taco" }) },
      brand: { findFirst: async () => ({ id: "b1" }) },
      buildGuide: {
        upsert: async ({ create }: any) => (rows.push({ id: "g", ...create, updatedAt: new Date() }), rows[rows.length - 1]),
        deleteMany: async () => ({ count: 0 }),
      },
    };
    return new BuildGuidesService(prisma);
  }

  it("stores a canonical link and step start times; a video alone keeps the guide", async () => {
    const rows: any[] = [];
    const g = await svcWith(rows).saveForItem("i1", "t1", {
      videoUrl: "https://youtu.be/dQw4w9WgXcQ?si=x",
      steps: [{ text: "Fold", videoStart: "0:45" }, { text: "Wrap", videoStart: "nope" }],
    });
    expect(g.videoUrl).toBe("https://www.youtube.com/watch?v=dQw4w9WgXcQ");
    expect(g.steps[0].videoStart).toBe(45);
    expect(g.steps[1]).not.toHaveProperty("videoStart");
    const onlyVideo = await svcWith([]).saveForItem("i1", "t1", { videoUrl: "dQw4w9WgXcQ", steps: [] });
    expect(onlyVideo).not.toBeNull();
  });

  it("rejects a link that is not YouTube", async () => {
    await expect(svcWith([]).saveForItem("i1", "t1", { videoUrl: "https://vimeo.com/1" })).rejects.toThrow("YouTube");
  });
});
