import Anthropic from "@anthropic-ai/sdk";
import { BadRequestException, Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { PrismaService } from "../../infrastructure/database/prisma.service";
import { AGENT_TOOLS, AGENT_TOOL_MAP } from "./agent.tools";

// ── Admin business co-pilot (Phase 1 — READ ONLY) ───────────────────────────
//
// A Claude tool-use loop over a registry of read-only, tenant-scoped tools.
// The agent can inspect and diagnose (menus, products, orders, data quality)
// but changes NOTHING — there are no write tools wired in this phase. Every
// tool call is scoped to the caller's tenant by the SERVER; the model never
// supplies a tenantId.

const DEFAULT_MODEL = "claude-sonnet-5";
const MAX_TOOL_ITERATIONS = 10;

export interface AgentChatTurn {
  role: "user" | "assistant";
  text: string;
}

const SYSTEM_PROMPT = `You are the Order Hub Admin Assistant — a co-pilot for a restaurant business owner/admin using the Order Hub platform.

You can READ the business's data through tools (brands, locations, menus, products, product data-quality, orders and their timelines) and help the operator understand and manage their business: auditing menus, finding data problems, explaining stuck orders, summarising activity, and drafting concrete plans.

IMPORTANT — this is a read-only assistant right now:
- You CANNOT change anything: there are no tools to create, edit, delete, 86, publish, price, or message. Do not claim you did or will change data.
- When the operator asks you to fix or create something, DO the analysis, then give them a precise, step-by-step plan (which menu, which items, exact values) they can act on — and note that a future version will be able to apply changes with their confirmation.

Style:
- Be concise and concrete. Prefer specifics (names, counts, prices, order refs) over generalities.
- Call tools to get real data before answering; never invent products, prices, or order details.
- Money is in GBP. When you show a problem, say exactly where it is and what to do about it.
- If a question is outside the business data you can read, say so plainly.`;

@Injectable()
export class AgentService {
  private readonly logger = new Logger(AgentService.name);
  private readonly anthropic: Anthropic | null;
  private readonly model: string;

  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
  ) {
    const apiKey = this.config.get<string>("ANTHROPIC_API_KEY");
    this.model = this.config.get<string>("AGENT_MODEL") ?? DEFAULT_MODEL;
    this.anthropic = apiKey ? new Anthropic({ apiKey }) : null;
    if (!this.anthropic) {
      this.logger.warn("ANTHROPIC_API_KEY not set — admin agent disabled");
    }
  }

  get configured(): boolean {
    return !!this.anthropic;
  }

  /**
   * Run one chat turn. `history` is the prior user/assistant text turns; the
   * last item is the new user message. Returns the assistant's reply plus the
   * names of the tools it used (for the UI to show its work). Tool execution
   * happens server-side, tenant-scoped, within this call.
   */
  async chat(
    tenantId: string,
    history: AgentChatTurn[],
  ): Promise<{ reply: string; toolsUsed: string[] }> {
    if (!this.anthropic) {
      throw new BadRequestException(
        "The admin assistant isn't configured (missing ANTHROPIC_API_KEY).",
      );
    }
    if (!Array.isArray(history) || history.length === 0) {
      throw new BadRequestException("Send at least one message.");
    }

    const messages: Anthropic.MessageParam[] = history
      .filter((t) => t && typeof t.text === "string" && t.text.trim())
      .map((t) => ({
        role: t.role === "assistant" ? "assistant" : "user",
        content: t.text,
      }));

    const tools: Anthropic.Tool[] = AGENT_TOOLS.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.input_schema as Anthropic.Tool.InputSchema,
    }));

    const toolsUsed: string[] = [];

    for (let i = 0; i < MAX_TOOL_ITERATIONS; i++) {
      const response = await this.anthropic.messages.create({
        model: this.model,
        max_tokens: 4096,
        system: SYSTEM_PROMPT,
        tools,
        messages,
      });

      messages.push({ role: "assistant", content: response.content });

      const toolUses = response.content.filter(
        (b): b is Anthropic.ToolUseBlock => b.type === "tool_use",
      );

      if (response.stop_reason !== "tool_use" || toolUses.length === 0) {
        const text = response.content
          .filter((b): b is Anthropic.TextBlock => b.type === "text")
          .map((b) => b.text)
          .join("\n")
          .trim();
        return {
          reply: text || "I couldn't produce a reply — try rephrasing.",
          toolsUsed,
        };
      }

      // Execute each requested tool, tenant-scoped, and feed results back.
      const results: Anthropic.ToolResultBlockParam[] = [];
      for (const call of toolUses) {
        const tool = AGENT_TOOL_MAP[call.name];
        toolsUsed.push(call.name);
        let content: string;
        try {
          if (!tool) throw new Error(`Unknown tool ${call.name}`);
          const out = await tool.run(
            this.prisma,
            tenantId,
            (call.input ?? {}) as Record<string, any>,
          );
          content = JSON.stringify(out).slice(0, 60_000);
        } catch (err) {
          const e = err as Error;
          this.logger.warn(`agent tool ${call.name} failed: ${e.message}`);
          content = JSON.stringify({ error: e.message ?? "tool failed" });
        }
        results.push({
          type: "tool_result",
          tool_use_id: call.id,
          content,
        });
      }
      messages.push({ role: "user", content: results });
    }

    return {
      reply:
        "That needed too many steps — try asking something more specific.",
      toolsUsed,
    };
  }
}
