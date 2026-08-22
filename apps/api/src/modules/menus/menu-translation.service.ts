import { randomBytes } from "crypto";
import Anthropic from "@anthropic-ai/sdk";
import { BadRequestException, Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { PrismaService } from "../../infrastructure/database/prisma.service";

// ── Menu translation for kitchen tickets ────────────────────────────────────
//
// Fills secondLanguageName across a menu's items, modifier groups and options
// so the kitchen ticket can print in the language the kitchen reads while the
// customer menu stays as written.
//
// Three things shape the implementation:
//
//   1. **One call per BATCH, never per name.** A Chinese takeaway menu runs to
//      a few hundred items and a couple of thousand options. A call each would
//      take an hour and cost accordingly.
//
//   2. **Dedupe first.** "Chips", "Curry Sauce" and "Cheese" repeat across
//      dozens of option groups — Best Kebab had 2,325 options but far fewer
//      distinct names. Translating distinct STRINGS rather than rows is the
//      difference between one batch and twenty.
//
//   3. **Runs as a background job.** The import taught us the hard way that a
//      request held open for a minute is killed by the proxy while the work
//      succeeds. Same pattern as the AI menu parse: start, poll, done.

const DEFAULT_MODEL = "claude-sonnet-5";
const JOB_TTL_MS = 15 * 60_000;
// Names per request. Big enough that a 200-item menu is a handful of calls,
// small enough that one failure does not cost the whole menu.
const BATCH = 120;

export interface TranslateJob {
  status: "pending" | "done" | "failed";
  createdAt: number;
  /** Rough progress for the UI: how many distinct names are done. */
  translated?: number;
  total?: number;
  result?: { items: number; groups: number; options: number; skipped: number };
  error?: string;
}

const TOOL_SCHEMA = {
  type: "object",
  properties: {
    translations: {
      type: "array",
      description: "One entry per name given, in the same order.",
      items: {
        type: "object",
        properties: {
          source: { type: "string", description: "The original name, copied exactly." },
          translated: {
            type: "string",
            description:
              "The name in the target language. Empty string if it should stay as-is.",
          },
        },
        required: ["source", "translated"],
      },
    },
  },
  required: ["translations"],
} as const;

function systemPrompt(language: string): string {
  return [
    `You translate restaurant menu names into ${language} for a KITCHEN TICKET.`,
    "",
    "The reader is a chef deciding what to cook, not a customer choosing.",
    "Translate what the dish IS. Prefer the name that kitchen actually uses for",
    "the dish over a literal word-for-word rendering.",
    "",
    "Rules:",
    `- Return every name given, in the same order, with "source" copied EXACTLY.`,
    "- Keep leading item numbers and codes as digits: \"138 Chicken Maryland\"",
    "  keeps its 138. Cooks call dishes by number.",
    "- Keep sizes and measurements recognisable (10\", 12\", 1/2, Large).",
    "- A brand or proper noun with no established translation stays as it is",
    "  (Pepsi, Heinz, Biscoff).",
    "- If a name is already in the target language, return it unchanged.",
    "- Never invent an ingredient the name does not mention. If you are unsure",
    "  what a dish is, return an empty string rather than a guess — a blank",
    "  prints the original name, and a wrong one sends the wrong food out.",
  ].join("\n");
}

@Injectable()
export class MenuTranslationService {
  private readonly logger = new Logger(MenuTranslationService.name);
  private readonly anthropic: Anthropic | null;
  private readonly model: string;
  private readonly jobs = new Map<string, TranslateJob>();

  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
  ) {
    const apiKey = this.config.get<string>("ANTHROPIC_API_KEY");
    this.model =
      this.config.get<string>("MENU_TRANSLATE_MODEL") ?? DEFAULT_MODEL;
    this.anthropic = apiKey ? new Anthropic({ apiKey }) : null;
    if (!this.anthropic) {
      this.logger.warn("ANTHROPIC_API_KEY not set — menu translation disabled");
    }
  }

  get configured(): boolean {
    return !!this.anthropic;
  }

  /** Kick off a translation; returns a job id to poll. */
  start(args: {
    menuId: string;
    tenantId: string;
    language: string;
    /** Re-translate names that already have one. Default false. */
    overwrite?: boolean;
  }): string {
    const jobId = randomBytes(16).toString("hex");
    this.jobs.set(jobId, { status: "pending", createdAt: Date.now() });
    void this.run(jobId, args)
      .then((result) =>
        this.jobs.set(jobId, {
          ...(this.jobs.get(jobId) ?? { createdAt: Date.now() }),
          status: "done",
          result,
        } as TranslateJob),
      )
      .catch((err: any) => {
        this.logger.error(
          `menu translation failed menu=${args.menuId}: ${err?.message ?? err}`,
          err?.stack,
        );
        this.jobs.set(jobId, {
          ...(this.jobs.get(jobId) ?? { createdAt: Date.now() }),
          status: "failed",
          error: err?.message ?? "Translation failed",
        } as TranslateJob);
      });
    this.sweep();
    return jobId;
  }

  getJob(jobId: string): TranslateJob | null {
    this.sweep();
    return this.jobs.get(jobId) ?? null;
  }

  private sweep(): void {
    const now = Date.now();
    for (const [id, j] of this.jobs) {
      if (now - j.createdAt > JOB_TTL_MS) this.jobs.delete(id);
    }
  }

  private async run(
    jobId: string,
    args: { menuId: string; tenantId: string; language: string; overwrite?: boolean },
  ): Promise<{ items: number; groups: number; options: number; skipped: number }> {
    if (!this.anthropic) {
      throw new BadRequestException(
        "Translation isn't set up — ANTHROPIC_API_KEY is missing on the server.",
      );
    }
    const language = args.language.trim();
    if (!language) throw new BadRequestException("Pick a language first");

    // Tenant check: a menu id alone must never reach another tenant's rows.
    const menu = await this.prisma.menu.findFirst({
      where: { id: args.menuId, brand: { tenantId: args.tenantId } },
      select: { id: true, brandId: true },
    });
    if (!menu) throw new BadRequestException("Menu not found");

    const needs = (v: string | null) => args.overwrite || !(v ?? "").trim();

    // A menu owns its items THROUGH its categories
    // (Menu -> MenuCategory -> MenuItemOnCategory -> MenuItem), which is how
    // the editor reads one. MenuItem.menuIds is a parallel array that only the
    // importers populate, so a menu built by cloning or by hand has items with
    // an empty menuIds — querying that alone found nothing at all and the job
    // reported "nothing to translate" on a full menu.
    //
    // Both are accepted: category membership is the truth, menuIds catches any
    // imported row whose category link was not written.
    const inThisMenu = {
      OR: [
        { categories: { some: { category: { menuId: menu.id } } } },
        { menuIds: { has: menu.id } },
      ],
    };

    // Narrow selects on purpose. This runs inside the API process, which sits
    // close to its heap ceiling on the current instance — there is no reason
    // to pull prices, images or JSON blobs to translate a name.
    const items = await this.prisma.menuItem.findMany({
      where: inThisMenu,
      // productSkus comes along because a SIZED product carries its modifier
      // groups THERE and nowhere else — see below.
      select: {
        id: true,
        name: true,
        secondLanguageName: true,
        productSkus: true,
      },
    });
    const itemIds = items.map((i) => i.id);

    // A multi-SKU product routes its groups through the SIZE: the picker reads
    // selectedSku.modifierGroups and ignores the item's own links, so those
    // rows carry bare group ids in productSkus[] with NO ModifierGroupOnItem
    // row to find them by. Looking only at itemLinks found every group on a
    // flat product and none on a pizza — which is exactly what "item names
    // translated, modifiers did not" looked like on the ticket.
    const skuGroupIds = new Set<string>();
    for (const it of items) {
      const skus = Array.isArray(it.productSkus) ? (it.productSkus as any[]) : [];
      for (const sku of skus) {
        for (const g of sku?.modifierGroups ?? []) {
          if (typeof g === "string" && g) skuGroupIds.add(g);
        }
      }
    }

    const groups = itemIds.length
      ? await this.prisma.modifierGroup.findMany({
          where: {
            // Tenant-scoped rather than brand-scoped: an imported menu
            // routinely references groups belonging to a sibling brand of the
            // same tenant, and filtering by brand would silently drop them.
            brand: { tenantId: args.tenantId },
            OR: [
              { itemLinks: { some: { itemId: { in: itemIds } } } },
              { menuIds: { has: menu.id } },
              ...(skuGroupIds.size
                ? [{ id: { in: Array.from(skuGroupIds) } }]
                : []),
            ],
          },
          select: { id: true, name: true, secondLanguageName: true },
        })
      : [];
    const options = groups.length
      ? await this.prisma.modifierOption.findMany({
          where: { groupId: { in: groups.map((g) => g.id) } },
          select: { id: true, name: true, secondLanguageName: true },
        })
      : [];

    const pending = [
      ...items.filter((r) => needs(r.secondLanguageName)),
      ...groups.filter((r) => needs(r.secondLanguageName)),
      ...options.filter((r) => needs(r.secondLanguageName)),
    ];

    // Distinct STRINGS, not rows: "Chips" appears in dozens of groups and is
    // the same word every time.
    const distinct = Array.from(
      new Set(pending.map((r) => r.name.trim()).filter(Boolean)),
    );
    this.jobs.set(jobId, {
      ...(this.jobs.get(jobId) ?? { createdAt: Date.now(), status: "pending" }),
      total: distinct.length,
      translated: 0,
    } as TranslateJob);

    const map = new Map<string, string>();
    for (let i = 0; i < distinct.length; i += BATCH) {
      const chunk = distinct.slice(i, i + BATCH);
      const got = await this.translateBatch(chunk, language);
      for (const [k, v] of got) map.set(k, v);
      const job = this.jobs.get(jobId);
      if (job) this.jobs.set(jobId, { ...job, translated: map.size });
    }

    // Write back. Rows whose translation came back blank are left alone — the
    // ticket keeps printing the original, which is the safe outcome.
    let written = { items: 0, groups: 0, options: 0, skipped: 0 };
    const write = async (
      table: "menuItem" | "modifierGroup" | "modifierOption",
      rows: Array<{ id: string; name: string; secondLanguageName: string | null }>,
      key: "items" | "groups" | "options",
    ) => {
      // Group ids by translation so identical names update together.
      const byValue = new Map<string, string[]>();
      for (const r of rows) {
        if (!needs(r.secondLanguageName)) continue;
        const v = (map.get(r.name.trim()) ?? "").trim();
        if (!v || v === r.name.trim()) {
          written.skipped++;
          continue;
        }
        const list = byValue.get(v);
        if (list) list.push(r.id);
        else byValue.set(v, [r.id]);
      }
      for (const [value, ids] of byValue) {
        const res = await (this.prisma as any)[table].updateMany({
          where: { id: { in: ids } },
          data: { secondLanguageName: value },
        });
        written[key] += res.count ?? ids.length;
      }
    };

    await write("menuItem", items, "items");
    await write("modifierGroup", groups, "groups");
    await write("modifierOption", options, "options");

    // Logs what it FOUND as well as what it changed. "0 options translated"
    // means two completely different things depending on whether it found
    // 0 options or found 300 that were already done — and the first time this
    // reported zero I could not tell which from the log.
    this.logger.log(
      `menu ${menu.id} -> ${language}: ` +
        `found ${items.length} items / ${groups.length} groups / ${options.length} options; ` +
        `${pending.length} needed a name (${distinct.length} distinct); ` +
        `wrote ${written.items} items / ${written.groups} groups / ${written.options} options; ` +
        `${written.skipped} left as-is`,
    );
    return written;
  }

  /** One model call for up to BATCH names. Returns source -> translated. */
  private async translateBatch(
    names: string[],
    language: string,
  ): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    const stream = this.anthropic!.messages.stream({
      model: this.model,
      max_tokens: 8000,
      system: systemPrompt(language),
      tools: [
        {
          name: "emit_translations",
          description: `Return every name translated into ${language}.`,
          input_schema: TOOL_SCHEMA as any,
        },
      ],
      tool_choice: { type: "tool", name: "emit_translations" },
      messages: [
        {
          role: "user",
          content:
            `Translate these ${names.length} menu names into ${language}:\n\n` +
            names.map((n, i) => `${i + 1}. ${n}`).join("\n"),
        },
      ],
    });
    const message = await stream.finalMessage();
    const tool = message.content.find((b) => b.type === "tool_use");
    if (!tool || tool.type !== "tool_use") {
      throw new Error("the model did not return translations");
    }
    const rows = (tool.input as any)?.translations;
    if (!Array.isArray(rows)) throw new Error("translations were not a list");

    const wanted = new Set(names.map((n) => n.trim()));
    for (const r of rows) {
      const src = String(r?.source ?? "").trim();
      const dst = String(r?.translated ?? "").trim();
      // Only accept names we actually asked about — a hallucinated source
      // would otherwise write a translation onto nothing, or worse, onto a
      // name from another batch.
      if (src && dst && wanted.has(src)) out.set(src, dst);
    }
    return out;
  }
}
