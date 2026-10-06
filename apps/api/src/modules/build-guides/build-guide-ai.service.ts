import { BadRequestException, Injectable, Logger, NotFoundException, ServiceUnavailableException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import Anthropic from "@anthropic-ai/sdk";
import { PrismaService } from "../../infrastructure/database/prisma.service";

const SYSTEM = `You write kitchen build guides ("build charts") for fast-food and takeaway kitchens.
A guide is a short ordered list of steps a new line cook can follow during a rush.
Rules:
- 4 to 9 steps, in the real order of assembly. One action per step, imperative, under 20 words.
- Put portion sizes in "amount" (e.g. "2 scoops", "120g", "1 ladle") and equipment in "tools" — never invent brand names.
- If the product has modifiers that ADD something (extra cheese, add bacon), write a step for it with onlyWith set to the exact modifier names.
- If a modifier REMOVES something (no onion, no sauce), set skipWith on the step that adds that ingredient, using the exact modifier names.
- Finish with a packNote: how to box/wrap it and what goes on the side.
- Use only ingredients implied by the name, description, photo and modifiers. When unsure, keep it generic rather than inventing.
- British English.`;

const TOOL_SCHEMA = {
  type: "object",
  properties: {
    steps: {
      type: "array",
      items: {
        type: "object",
        properties: {
          text: { type: "string" },
          amount: { type: "string" },
          tools: { type: "array", items: { type: "string" } },
          onlyWith: { type: "array", items: { type: "string" } },
          skipWith: { type: "array", items: { type: "string" } },
        },
        required: ["text"],
      },
    },
    packNote: { type: "string" },
  },
  required: ["steps"],
};

/**
 * "Draft with AI" — a first version of a guide from the product's name,
 * description, photo and modifiers. Never saved here: the editor shows it,
 * the operator fixes it and adds photos, then saves as usual.
 */
@Injectable()
export class BuildGuideAiService {
  private readonly logger = new Logger(BuildGuideAiService.name);
  private readonly anthropic: Anthropic | null;
  private readonly model: string;

  constructor(
    private readonly prisma: PrismaService,
    config: ConfigService,
  ) {
    const key = config.get<string>("ANTHROPIC_API_KEY");
    this.anthropic = key ? new Anthropic({ apiKey: key }) : null;
    this.model = config.get<string>("BUILD_GUIDE_AI_MODEL") ?? "claude-sonnet-5-5";
  }

  /** Test seam — swap in a fake client. */
  setClientForTests(client: unknown) {
    (this as any).anthropic = client;
  }

  async draft(itemId: string, tenantId: string) {
    if (!this.anthropic) throw new ServiceUnavailableException("AI drafts aren't configured (missing ANTHROPIC_API_KEY).");

    const item: any = await this.prisma.menuItem.findUnique({
      where: { id: itemId },
      include: {
        modifierGroupLinks: {
          orderBy: { sortOrder: "asc" },
          include: { group: { include: { options: { orderBy: { sortOrder: "asc" } } } } },
        },
      },
    });
    if (!item) throw new NotFoundException("Menu item not found");
    const brand = await this.prisma.brand.findFirst({ where: { id: item.brandId, tenantId }, select: { name: true } });
    if (!brand) throw new NotFoundException("Menu item not found");

    const groups = (item.modifierGroupLinks ?? [])
      .map((l: any) => l.group)
      .filter(Boolean)
      .map((g: any) => `- ${g.name}: ${(g.options ?? []).map((o: any) => o.name).join(", ")}`)
      .join("\n");
    const prompt = [
      `Brand: ${brand.name}`,
      `Product: ${item.name}`,
      item.description ? `Description: ${item.description}` : null,
      groups ? `Modifier groups and options:\n${groups}` : "No modifiers.",
      "Write the build guide.",
    ]
      .filter(Boolean)
      .join("\n");

    const content: Anthropic.MessageParam["content"] = [];
    if (typeof item.imageUrl === "string" && /^https:\/\//.test(item.imageUrl)) {
      content.push({ type: "image", source: { type: "url", url: item.imageUrl } } as any);
    }
    content.push({ type: "text", text: prompt });

    const ask = async (blocks: Anthropic.MessageParam["content"]) => {
      const msg = await this.anthropic!.messages.create({
        model: this.model,
        max_tokens: 2500,
        system: SYSTEM,
        tools: [{ name: "emit_guide", description: "Return the build guide.", input_schema: TOOL_SCHEMA as any }],
        tool_choice: { type: "tool", name: "emit_guide" },
        messages: [{ role: "user", content: blocks }],
      });
      const tool = msg.content.find((b) => b.type === "tool_use");
      if (!tool || tool.type !== "tool_use") throw new Error("no structured guide returned");
      return tool.input;
    };

    let input: any;
    try {
      try {
        input = await ask(content);
      } catch (err: any) {
        // A product photo the API can't fetch (expired link, private bucket)
        // is a 400 — the name and modifiers alone still make a fair draft.
        if (!(err instanceof Anthropic.APIError && err.status === 400 && (content as any[]).length > 1)) throw err;
        this.logger.warn(`Draft for ${itemId}: photo rejected (${err.message}); retrying text-only`);
        input = await ask([{ type: "text", text: prompt }]);
      }
    } catch (err: any) {
      this.logger.error(`AI build-guide draft failed for ${itemId}: ${err?.message ?? err}`);
      throw new BadRequestException(
        err instanceof Anthropic.APIError
          ? `The AI is temporarily unavailable (${err.status}). Try again in a moment.`
          : "Couldn't draft a guide for this product. Try again.",
      );
    }

    const str = (v: unknown, max: number) => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : undefined);
    const list = (v: unknown) =>
      Array.isArray(v) ? (v.map((x) => str(x, 80)).filter(Boolean) as string[]).slice(0, 8) : [];
    const steps = (Array.isArray(input?.steps) ? input.steps : [])
      .slice(0, 15)
      .map((s: any) => ({
        text: str(s?.text, 1000) ?? "",
        amount: str(s?.amount, 80) ?? null,
        tools: list(s?.tools),
        onlyWith: list(s?.onlyWith),
        skipWith: list(s?.skipWith),
      }))
      .filter((s: any) => s.text);
    return { steps, packNote: str(input?.packNote, 1000) ?? null };
  }
}
