import Anthropic from "@anthropic-ai/sdk";
import { BadRequestException, Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { randomBytes } from "crypto";
import type { AiMenuDraft } from "./ai-menu.classifier";

// ── AI menu parse service ───────────────────────────────────────────────────
//
// Reads an uploaded menu (PDF / JPEG / PNG / WebP) with Claude vision and
// returns a structured AiMenuDraft for the operator to review before it's
// committed to the catalog. Uses forced tool-use as the structured-output
// channel — the model MUST call `emit_menu`, and its validated input IS the
// draft. No DB writes happen here.

const DEFAULT_MODEL = "claude-opus-4-8";

const ALLOWED_MEDIA = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
  "application/pdf",
  // Saved web pages (Cmd+S on an Uber Eats / Deliveroo / Just Eat store
  // page) and plain pasted text. Delivery platforms block server-side
  // fetching of their pages, but the operator's own browser loads them
  // fine — saving the page and dropping the file here imports the menu.
  "text/html",
  "text/plain",
]);

/** Character budget for text extracted from an HTML/TXT upload. Delivery
 *  pages embed the full menu as JSON, which compresses the useful content —
 *  but raw saved pages can be many MB of framework noise, so cap what we
 *  forward to the model. */
const MAX_TEXT_CHARS = 180_000;

/** Distil a saved web page into what the model needs: any embedded
 *  structured state (Deliveroo/Next.js `__NEXT_DATA__`, Uber's preloaded
 *  state) plus the visible text, scripts/styles stripped. */
export function distilHtml(rawHtml: string): string {
  // Chrome's "Save page" default is MHTML (quoted-printable multipart).
  // Decode the soft line breaks (=\r\n) and =XX hex escapes so the tag
  // stripper below sees real HTML instead of escape noise.
  const html = /Content-Transfer-Encoding:\s*quoted-printable/i.test(rawHtml)
    ? rawHtml
        .replace(/=\r?\n/g, "")
        .replace(/=([0-9A-F]{2})/g, (_, h: string) =>
          String.fromCharCode(parseInt(h, 16)),
        )
    : rawHtml;
  const parts: string[] = [];

  // Embedded JSON state first — when present it contains the exact menu.
  const nextData = /<script[^>]*id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/i.exec(html);
  if (nextData?.[1]) {
    parts.push(`EMBEDDED PAGE DATA (JSON):\n${nextData[1]}`);
  } else {
    // Uber Eats: a <script type="application/json" id="__REACT_QUERY_STATE__">
    // tag holding the store's full catalog, with every quote escaped as
    // " (and nested layers escaped further — verified against a real
    // saved store page). It is NOT strictly parseable JSON, so don't parse:
    // decode the escapes textually and pull the menu fields out in
    // serialization order, which keeps each item's name/description/price
    // adjacent. That ordered stream is exactly what the model needs.
    const uberState =
      /<script[^>]*type="application\/json"[^>]*id="__REACT_QUERY_STATE__"[^>]*>([\s\S]*?)<\/script>/i.exec(
        html,
      );
    if (uberState?.[1]) {
      const decoded = uberState[1]
        .trim()
        .replace(/\\u([0-9a-fA-F]{4})/g, (_, h: string) =>
          String.fromCharCode(parseInt(h, 16)),
        );
      const clean = (s: string) => {
        try {
          return decodeURIComponent(s.replace(/%25/g, "%"));
        } catch {
          return s;
        }
      };
      const lines: string[] = [];
      const fieldRe =
        /"(sectionName|title|itemDescription)":"([^"]{2,600})"|"priceTagline":\{"text":"([^"]{1,30})"/g;
      let f: RegExpExecArray | null;
      while ((f = fieldRe.exec(decoded))) {
        if (f[3]) lines.push(`PRICE: ${clean(f[3])}`);
        else if (f[1] === "itemDescription") lines.push(`DESC: ${clean(f[2]!)}`);
        else if (f[1] === "sectionName") lines.push(`SECTION: ${clean(f[2]!)}`);
        else lines.push(`ITEM: ${clean(f[2]!)}`);
      }
      // Only trust the stream when it clearly is a menu (a real store page
      // yields one PRICE line per product).
      if (lines.filter((l) => l.startsWith("PRICE:")).length >= 5) {
        parts.push(
          `EMBEDDED MENU FIELDS (from the platform's own catalog data, in order — ITEM/DESC/PRICE lines belong to the same product; ignore non-menu noise lines):\n${lines.join("\n")}`,
        );
      }
    } else {
      // Older style: a big JSON assignment in an inline script.
      const preloaded = /__REACT_QUERY_STATE__\s*=\s*(\{[\s\S]*?\});?\s*<\/script>/.exec(html)
        ?? /window\.__INITIAL_STATE__\s*=\s*(\{[\s\S]*?\});?\s*<\/script>/.exec(html);
      if (preloaded?.[1]) parts.push(`EMBEDDED PAGE DATA (JSON):\n${preloaded[1]}`);
    }
  }

  // Visible text: drop script/style/head noise, strip tags, collapse space.
  const visible = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<head[\s\S]*?<\/head>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&#?\w+;/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
  if (visible) parts.push(`VISIBLE PAGE TEXT:\n${visible}`);

  return parts.join("\n\n").slice(0, MAX_TEXT_CHARS);
}

// The API body limit is 10 MB; keep the combined base64 well under it.
const MAX_TOTAL_B64 = 7_000_000;
const MAX_FILES = 8;

/** One uploaded file. `data` is base64 (optionally a `data:` URL). */
export interface AiMenuFile {
  mediaType?: string;
  data: string;
}

const SYSTEM_PROMPT = `You are a precise menu-digitisation engine for a restaurant ordering platform. You are given one or more sources for a single restaurant's menu: images, PDF pages, or the saved text/embedded data of a delivery-platform web page (Uber Eats, Deliveroo, Just Eat, or the restaurant's own site). Transcribe it faithfully into structured data by calling the emit_menu tool.

When a source contains EMBEDDED PAGE DATA (JSON), prefer it over the visible page text — it is the platform's own structured menu (exact names, prices in minor units or decimals, descriptions, categories, modifier groups). Convert minor-unit prices (e.g. 1099) to decimals (10.99). Ignore JSON that is clearly not menu data (tracking, experiments, session state).

Rules:
- Transcribe only what is on the menu. Never invent items, prices, sizes, or modifiers.
- Group items under the categories/sections printed on the menu (e.g. "Starters", "Pizzas", "Drinks"). Preserve the printed order.
- Prices are decimal numbers in the menu's own currency, with NO currency symbol (e.g. 9.99, not "£9.99"). If a price is genuinely missing, use 0.
- If an item is offered in multiple sizes at different prices (Small/Medium/Large, 10"/12"/14", Regular/Large), put each size in the item's "sizes" array with its own price. Do NOT create separate items per size. For single-price items, set "price" and omit "sizes".
- Capture item descriptions when printed (ingredients, "served with…"). Leave description empty if there is none — do not write marketing copy.
- Modifiers / options / add-ons (e.g. "Choose your sauce", "Add toppings", "Pick a side"): create a shared entry in modifierGroups with a stable "key", then reference that key from every item it applies to via "modifierGroupKeys". Reuse one group across items rather than duplicating it.
- selectionType: VARIANT when the customer picks exactly one (a required choice like sauce or size-as-choice); ADDON when they can pick several (extra toppings). Set minSelections/maxSelections from the menu wording ("choose 1", "up to 3"); default VARIANT to min 1 max 1 and ADDON to min 0.
- Put anything you were unsure about (illegible price, ambiguous size, guessed category) into "warnings" so the operator can check it.`;

const USER_INSTRUCTION =
  "Digitise this menu. Read every page/image, then call emit_menu with the full structured menu. Be thorough — include every category, item, size price, description, and modifier group you can read.";

// JSON Schema for the emit_menu tool input (== AiMenuDraft).
const MENU_TOOL_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    menuName: {
      type: "string",
      description: "A sensible name for this menu (e.g. the restaurant name or 'Main Menu').",
    },
    currency: { type: "string", description: "ISO currency code if printed (e.g. GBP, EUR, USD)." },
    categories: {
      type: "array",
      description: "Menu sections in printed order.",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          name: { type: "string" },
          description: { type: "string" },
          items: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                name: { type: "string" },
                description: { type: "string" },
                price: { type: "number", description: "Single price. Omit when sizes[] is used." },
                sku: { type: "string", description: "Item/PLU code if printed." },
                sizes: {
                  type: "array",
                  description: "Use when the item has multiple sizes at different prices.",
                  items: {
                    type: "object",
                    additionalProperties: false,
                    properties: {
                      name: { type: "string" },
                      price: { type: "number" },
                      sku: { type: "string" },
                    },
                    required: ["name", "price"],
                  },
                },
                modifierGroupKeys: {
                  type: "array",
                  description: "Keys of modifierGroups that apply to this item.",
                  items: { type: "string" },
                },
              },
              required: ["name"],
            },
          },
        },
        required: ["name", "items"],
      },
    },
    modifierGroups: {
      type: "array",
      description: "Shared option groups, referenced by items via key.",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          key: { type: "string", description: "Stable id you assign, e.g. 'g_sauce'." },
          name: { type: "string" },
          selectionType: { type: "string", enum: ["VARIANT", "ADDON"] },
          minSelections: { type: "integer" },
          maxSelections: { type: "integer" },
          options: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                name: { type: "string" },
                priceAdjustment: { type: "number", description: "Extra cost; 0 if free." },
                pricesBySize: {
                  type: "array",
                  description: "Only if this option costs different amounts per size.",
                  items: {
                    type: "object",
                    additionalProperties: false,
                    properties: {
                      sizeName: { type: "string" },
                      price: { type: "number" },
                    },
                    required: ["sizeName", "price"],
                  },
                },
              },
              required: ["name"],
            },
          },
        },
        required: ["key", "name", "selectionType", "options"],
      },
    },
    warnings: {
      type: "array",
      description: "Anything uncertain the operator should double-check.",
      items: { type: "string" },
    },
  },
  required: ["categories"],
} as const;

function normalizeFile(f: AiMenuFile): { mediaType: string; data: string } {
  if (!f || typeof f.data !== "string" || !f.data) {
    throw new BadRequestException("A file is missing its data.");
  }
  let data = f.data;
  let mediaType = (f.mediaType ?? "").toLowerCase();
  const dataUrl = /^data:([^;,]+)(;base64)?,(.*)$/i.exec(data);
  if (dataUrl) {
    mediaType = (mediaType || dataUrl[1] || "").toLowerCase();
    data = dataUrl[3] ?? data;
  }
  // Strip whitespace/newlines some clients add to base64.
  data = data.replace(/\s/g, "");
  return { mediaType, data };
}

/** A background parse job. Parsing a large menu can exceed the ~60s proxy
 *  timeout in front of the API (a real 179-item Uber page took 67s and the
 *  browser saw a bogus 500 while the server finished fine) — so the client
 *  starts a job and polls, and no HTTP request ever runs long. */
export interface AiParseJob {
  status: "pending" | "done" | "failed";
  draft?: AiMenuDraft;
  error?: string;
  createdAt: number;
}

const JOB_TTL_MS = 15 * 60_000;

@Injectable()
export class AiMenuParseService {
  private readonly logger = new Logger(AiMenuParseService.name);
  private readonly anthropic: Anthropic | null;
  private readonly model: string;
  private readonly textModel: string;
  private readonly jobs = new Map<string, AiParseJob>();

  constructor(private readonly config: ConfigService) {
    const apiKey = this.config.get<string>("ANTHROPIC_API_KEY");
    this.model = this.config.get<string>("MENU_IMPORT_MODEL") ?? DEFAULT_MODEL;
    // Text sources (saved web pages) arrive pre-extracted as clean
    // ITEM/DESC/PRICE lines — structuring them is mechanical, so a faster
    // model cuts a 179-item parse from ~67s to well under the timeout while
    // vision (photos/PDFs) keeps the strongest model.
    this.textModel =
      this.config.get<string>("MENU_IMPORT_TEXT_MODEL") ?? "claude-sonnet-5";
    this.anthropic = apiKey ? new Anthropic({ apiKey }) : null;
    if (!this.anthropic) {
      this.logger.warn("ANTHROPIC_API_KEY not set — AI menu import disabled");
    }
  }

  /** Start a parse in the background; returns a job id to poll. */
  startParse(files: AiMenuFile[]): string {
    const jobId = randomBytes(16).toString("hex");
    this.jobs.set(jobId, { status: "pending", createdAt: Date.now() });
    void this.parse(files)
      .then((draft) =>
        this.jobs.set(jobId, { status: "done", draft, createdAt: Date.now() }),
      )
      .catch((err: unknown) => {
        const e = err as { message?: string; response?: { message?: string } };
        this.jobs.set(jobId, {
          status: "failed",
          error:
            e?.response?.message ?? e?.message ?? "Couldn't read this menu.",
          createdAt: Date.now(),
        });
      });
    this.sweepJobs();
    return jobId;
  }

  getJob(jobId: string): AiParseJob | null {
    this.sweepJobs();
    return this.jobs.get(jobId) ?? null;
  }

  private sweepJobs(): void {
    const now = Date.now();
    for (const [id, job] of this.jobs) {
      if (now - job.createdAt > JOB_TTL_MS) this.jobs.delete(id);
    }
  }

  get configured(): boolean {
    return !!this.anthropic;
  }

  async parse(files: AiMenuFile[]): Promise<AiMenuDraft> {
    if (!this.anthropic) {
      throw new BadRequestException(
        "AI menu import isn't configured (missing ANTHROPIC_API_KEY).",
      );
    }
    if (!Array.isArray(files) || files.length === 0) {
      throw new BadRequestException("Upload at least one menu file.");
    }
    if (files.length > MAX_FILES) {
      throw new BadRequestException(`Too many files — upload at most ${MAX_FILES}.`);
    }

    const blocks: Anthropic.MessageParam["content"] = [];
    let totalB64 = 0;
    for (const f of files) {
      const { mediaType, data } = normalizeFile(f);
      if (!ALLOWED_MEDIA.has(mediaType)) {
        throw new BadRequestException(
          `Unsupported file type "${mediaType || "unknown"}". Upload a PDF, JPEG, PNG, WebP, saved web page (.html) or text file.`,
        );
      }
      totalB64 += data.length;
      if (totalB64 > MAX_TOTAL_B64) {
        throw new BadRequestException(
          "Files are too large. Keep the total under ~5 MB — compress the photos or upload fewer pages.",
        );
      }
      if (mediaType === "application/pdf") {
        blocks.push({
          type: "document",
          source: { type: "base64", media_type: "application/pdf", data },
        } as Anthropic.DocumentBlockParam);
      } else if (mediaType === "text/html" || mediaType === "text/plain") {
        const raw = Buffer.from(data, "base64").toString("utf8");
        const text =
          mediaType === "text/html" ? distilHtml(raw) : raw.slice(0, MAX_TEXT_CHARS);
        if (text.trim()) {
          blocks.push({ type: "text", text: `MENU SOURCE (uploaded ${mediaType === "text/html" ? "web page" : "text"}):\n${text}` });
        }
      } else {
        blocks.push({
          type: "image",
          source: { type: "base64", media_type: mediaType as any, data },
        });
      }
    }
    // All-text sources (saved web pages) get the faster text model; any
    // image/PDF in the mix needs the vision-strong default.
    const textOnly = blocks.every((b) => (b as { type: string }).type === "text");
    blocks.push({ type: "text", text: USER_INSTRUCTION });

    let toolInput: unknown;
    try {
      // Stream + finalMessage: menus can be long, so give the model room and
      // avoid request-timeout on large structured output.
      const stream = this.anthropic.messages.stream({
        model: textOnly ? this.textModel : this.model,
        max_tokens: 16000,
        system: SYSTEM_PROMPT,
        tools: [
          {
            name: "emit_menu",
            description: "Return the fully structured menu extracted from the uploaded files.",
            input_schema: MENU_TOOL_SCHEMA as any,
          },
        ],
        tool_choice: { type: "tool", name: "emit_menu" },
        messages: [{ role: "user", content: blocks }],
      });
      const message = await stream.finalMessage();
      const tool = message.content.find((b) => b.type === "tool_use");
      if (!tool || tool.type !== "tool_use") {
        throw new Error("the model did not return a structured menu");
      }
      toolInput = tool.input;
    } catch (err) {
      const e = err as Error;
      this.logger.error(`AI menu parse failed: ${e.message}`, e.stack);
      throw new BadRequestException(
        e instanceof Anthropic.APIError
          ? `The menu reader is temporarily unavailable (${e.status}). Try again in a moment.`
          : "Couldn't read this menu. Try a clearer photo or a PDF.",
      );
    }

    return this.sanitize(toolInput as AiMenuDraft);
  }

  /** Light shape-guarding; the classifier does the heavy coercion. */
  private sanitize(draft: AiMenuDraft): AiMenuDraft {
    const categories = Array.isArray(draft?.categories) ? draft.categories : [];
    const itemCount = categories.reduce(
      (n, c) => n + (Array.isArray(c?.items) ? c.items.length : 0),
      0,
    );
    if (itemCount === 0) {
      throw new BadRequestException(
        "No menu items could be read from the upload. Try a clearer, higher-resolution image or a PDF.",
      );
    }
    return {
      menuName: typeof draft.menuName === "string" ? draft.menuName : undefined,
      currency: typeof draft.currency === "string" ? draft.currency : undefined,
      categories,
      modifierGroups: Array.isArray(draft.modifierGroups) ? draft.modifierGroups : [],
      warnings: Array.isArray(draft.warnings) ? draft.warnings : [],
    };
  }
}
