import Anthropic from "@anthropic-ai/sdk";
import { BadRequestException, Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
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
]);

// The API body limit is 10 MB; keep the combined base64 well under it.
const MAX_TOTAL_B64 = 7_000_000;
const MAX_FILES = 8;

/** One uploaded file. `data` is base64 (optionally a `data:` URL). */
export interface AiMenuFile {
  mediaType?: string;
  data: string;
}

const SYSTEM_PROMPT = `You are a precise menu-digitisation engine for a restaurant ordering platform. You are given one or more images or PDF pages of a single restaurant's menu. Transcribe it faithfully into structured data by calling the emit_menu tool.

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

@Injectable()
export class AiMenuParseService {
  private readonly logger = new Logger(AiMenuParseService.name);
  private readonly anthropic: Anthropic | null;
  private readonly model: string;

  constructor(private readonly config: ConfigService) {
    const apiKey = this.config.get<string>("ANTHROPIC_API_KEY");
    this.model = this.config.get<string>("MENU_IMPORT_MODEL") ?? DEFAULT_MODEL;
    this.anthropic = apiKey ? new Anthropic({ apiKey }) : null;
    if (!this.anthropic) {
      this.logger.warn("ANTHROPIC_API_KEY not set — AI menu import disabled");
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
          `Unsupported file type "${mediaType || "unknown"}". Upload a PDF, JPEG, PNG or WebP.`,
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
      } else {
        blocks.push({
          type: "image",
          source: { type: "base64", media_type: mediaType as any, data },
        });
      }
    }
    blocks.push({ type: "text", text: USER_INSTRUCTION });

    let toolInput: unknown;
    try {
      // Stream + finalMessage: menus can be long, so give the model room and
      // avoid request-timeout on large structured output.
      const stream = this.anthropic.messages.stream({
        model: this.model,
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
