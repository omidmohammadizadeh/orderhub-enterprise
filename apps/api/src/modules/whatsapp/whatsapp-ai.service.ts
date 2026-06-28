import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import Anthropic from "@anthropic-ai/sdk";
import { PrismaService } from "../../infrastructure/database/prisma.service";
import { WhatsAppMenuService, WaMenuContext } from "./whatsapp-menu.service";
import { WhatsAppSendService } from "./whatsapp-send.service";
import {
  WaCart,
  WaCartLine,
  coerceCart,
  emptyCart,
  cartItemCount,
  cartSubtotal,
  summarizeCart,
} from "./whatsapp-cart";

// Phase AY (P2) — the AI conversation engine. Maps free-text WhatsApp messages
// to the live menu using Claude (tool use), maintains a per-conversation cart,
// and replies with text or WhatsApp interactive messages. Order creation
// (cart → ingestCanonical), payment, and status replies land in P3–P5; the
// `checkout` tool here validates and stages the order, leaving a clean seam.

const MODEL = "claude-opus-4-8";
const MAX_TURN_ITERATIONS = 6;
const HISTORY_LIMIT = 20; // turns kept in the rolling transcript

interface TranscriptTurn {
  role: "user" | "assistant";
  content: string;
}

// A UI presentation the engine should send after the tool loop completes.
type Presentation =
  | { kind: "buttons"; body: string; buttons: { id: string; title: string }[] }
  | {
      kind: "list";
      body: string;
      buttonLabel: string;
      header?: string;
      sections: { title?: string; rows: { id: string; title: string; description?: string }[] }[];
    };

@Injectable()
export class WhatsAppAiService {
  private readonly logger = new Logger(WhatsAppAiService.name);
  private readonly anthropic: Anthropic | null;

  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
    private readonly menu: WhatsAppMenuService,
    private readonly send: WhatsAppSendService,
  ) {
    const apiKey = this.config.get<string>("ANTHROPIC_API_KEY");
    this.anthropic = apiKey ? new Anthropic({ apiKey }) : null;
    if (!this.anthropic) {
      this.logger.warn("ANTHROPIC_API_KEY not set — WhatsApp AI engine disabled");
    }
  }

  /** Entry point from the webhook for one inbound text message. */
  async handleMessage(args: {
    phoneNumberId: string;
    from: string;
    text: string;
    profileName?: string;
  }): Promise<void> {
    const { phoneNumberId, from, text, profileName } = args;

    const ctx = await this.menu.resolveContext(phoneNumberId);
    if (!ctx) {
      await this.send.sendText(
        phoneNumberId,
        from,
        "Sorry — ordering isn't set up for this number yet. Please try again later.",
      );
      return;
    }

    if (!this.anthropic) {
      await this.send.sendText(
        phoneNumberId,
        from,
        "Sorry — our ordering assistant is temporarily unavailable. Please try again shortly.",
      );
      return;
    }

    // ── Load / create the conversation ────────────────────────────────────
    const convo = await this.prisma.whatsAppConversation.upsert({
      where: { phoneNumberId_waPhone: { phoneNumberId, waPhone: from } },
      create: {
        tenantId: ctx.tenantId,
        locationId: ctx.locationId,
        brandId: ctx.brandId ?? null,
        waPhone: from,
        phoneNumberId,
        state: "BROWSING",
        cart: emptyCart() as any,
        customerName: profileName ?? null,
        lastInboundAt: new Date(),
      },
      update: { lastInboundAt: new Date() },
    });

    const cart = coerceCart(convo.cart);
    const history = this.coerceHistory(convo.messages);

    // ── Run the Claude tool loop ──────────────────────────────────────────
    let presentation: Presentation | null = null;
    const messages: Anthropic.MessageParam[] = [
      ...history.map((t) => ({ role: t.role, content: t.content })),
      { role: "user" as const, content: text },
    ];
    const tools = this.toolDefs();
    let finalText = "";

    try {
      for (let i = 0; i < MAX_TURN_ITERATIONS; i++) {
        const response = await this.anthropic.messages.create({
          model: MODEL,
          max_tokens: 1024,
          system: this.systemPrompt(ctx, cart),
          tools,
          messages,
        });

        const toolUses = response.content.filter(
          (b): b is Anthropic.ToolUseBlock => b.type === "tool_use",
        );
        const textBlocks = response.content
          .filter((b): b is Anthropic.TextBlock => b.type === "text")
          .map((b) => b.text)
          .join("\n")
          .trim();
        if (textBlocks) finalText = textBlocks;

        if (response.stop_reason !== "tool_use" || toolUses.length === 0) {
          break;
        }

        // Execute each tool and feed results back.
        messages.push({ role: "assistant", content: response.content });
        const results: Anthropic.ToolResultBlockParam[] = [];
        for (const tu of toolUses) {
          const { result, present } = this.runTool(tu.name, tu.input, ctx, cart);
          if (present) presentation = present;
          results.push({
            type: "tool_result",
            tool_use_id: tu.id,
            content: result,
          });
        }
        messages.push({ role: "user", content: results });
      }
    } catch (err: any) {
      this.logger.error(`WhatsApp AI turn failed: ${err?.message ?? err}`);
      await this.send.sendText(
        phoneNumberId,
        from,
        "Sorry, something went wrong on our side. Could you say that again?",
      );
      return;
    }

    // ── Send the reply (interactive presentation wins over plain text) ────
    let assistantRecord: string;
    if (presentation) {
      assistantRecord = presentation.body;
      if (presentation.kind === "buttons") {
        await this.send.sendButtons(
          phoneNumberId,
          from,
          presentation.body,
          presentation.buttons,
        );
      } else {
        await this.send.sendList(
          phoneNumberId,
          from,
          presentation.body,
          presentation.buttonLabel,
          presentation.sections,
          presentation.header,
        );
      }
    } else {
      assistantRecord = finalText || "Sorry, I didn't catch that — what would you like to order?";
      await this.send.sendText(phoneNumberId, from, assistantRecord);
    }

    // ── Persist cart, transcript, and derived state ───────────────────────
    const nextHistory = [
      ...history,
      { role: "user" as const, content: text },
      { role: "assistant" as const, content: assistantRecord },
    ].slice(-HISTORY_LIMIT);

    await this.prisma.whatsAppConversation.update({
      where: { id: convo.id },
      data: {
        cart: cart as any,
        messages: nextHistory as any,
        state: cart.items.length > 0 ? "CART" : "BROWSING",
        lastOutboundAt: new Date(),
        ...(profileName && !convo.customerName ? { customerName: profileName } : {}),
      },
    });
  }

  // ── Claude tool definitions ─────────────────────────────────────────────
  private toolDefs(): Anthropic.Tool[] {
    return [
      {
        name: "add_to_cart",
        description:
          "Add a menu item to the cart. Use the exact item id from the menu. Include modifier option ids for any chosen options. If the item has required modifier groups and the customer hasn't chosen yet, ask them first instead of calling this.",
        input_schema: {
          type: "object",
          properties: {
            itemId: { type: "string", description: "Menu item id (the [id:...] value)" },
            quantity: { type: "integer", minimum: 1, default: 1 },
            modifierOptionIds: {
              type: "array",
              items: { type: "string" },
              description: "Chosen modifier option ids (the [opt:...] values)",
            },
            notes: { type: "string", description: "Special request for this item" },
          },
          required: ["itemId"],
        },
      },
      {
        name: "update_line",
        description:
          "Change the quantity of a cart line, or remove it (quantity 0). Use the lineId shown in the cart state.",
        input_schema: {
          type: "object",
          properties: {
            lineId: { type: "string" },
            quantity: { type: "integer", minimum: 0 },
          },
          required: ["lineId", "quantity"],
        },
      },
      {
        name: "clear_cart",
        description: "Empty the entire cart.",
        input_schema: { type: "object", properties: {} },
      },
      {
        name: "set_fulfillment",
        description:
          "Set delivery vs pickup, and the delivery address when delivering. Always confirm the address back to the customer.",
        input_schema: {
          type: "object",
          properties: {
            type: { type: "string", enum: ["DELIVERY", "PICKUP"] },
            line1: { type: "string" },
            line2: { type: "string" },
            city: { type: "string" },
            postcode: { type: "string" },
          },
          required: ["type"],
        },
      },
      {
        name: "show_menu",
        description:
          "Show the customer a tappable list of menu items (optionally filtered to one category) so they can pick. Provide a short body line. Use when the customer asks what's available or to browse.",
        input_schema: {
          type: "object",
          properties: {
            body: { type: "string", description: "Short message shown above the list" },
            category: {
              type: "string",
              description: "Optional category name to filter to",
            },
          },
          required: ["body"],
        },
      },
      {
        name: "show_buttons",
        description:
          "Show up to 3 quick-reply buttons under a message (e.g. Checkout / Add more / View menu). Provide the body and button titles.",
        input_schema: {
          type: "object",
          properties: {
            body: { type: "string" },
            buttons: {
              type: "array",
              maxItems: 3,
              items: {
                type: "object",
                properties: {
                  id: { type: "string" },
                  title: { type: "string", description: "Max 20 chars" },
                },
                required: ["id", "title"],
              },
            },
          },
          required: ["body", "buttons"],
        },
      },
      {
        name: "checkout",
        description:
          "Validate the cart and stage the order for confirmation. Only call once the customer has chosen items, fulfillment, and (for delivery) an address, and has confirmed they're ready to order.",
        input_schema: { type: "object", properties: {} },
      },
    ];
  }

  // ── Tool execution (returns a text result for Claude + optional UI) ──────
  private runTool(
    name: string,
    input: any,
    ctx: WaMenuContext,
    cart: WaCart,
  ): { result: string; present?: Presentation } {
    switch (name) {
      case "add_to_cart":
        return { result: this.addToCart(input, ctx, cart) };
      case "update_line":
        return { result: this.updateLine(input, cart) };
      case "clear_cart":
        cart.items = [];
        return { result: "Cart cleared." };
      case "set_fulfillment":
        return { result: this.setFulfillment(input, cart) };
      case "show_menu":
        return this.showMenu(input, ctx);
      case "show_buttons":
        return this.showButtons(input);
      case "checkout":
        return { result: this.checkout(ctx, cart) };
      default:
        return { result: `Unknown tool ${name}.` };
    }
  }

  private addToCart(input: any, ctx: WaMenuContext, cart: WaCart): string {
    const item = ctx.itemIndex.get(String(input.itemId));
    if (!item) return `No menu item with id ${input.itemId}. Pick one from the menu.`;
    const quantity = Math.max(1, Math.round(Number(input.quantity) || 1));

    const optionIds: string[] = Array.isArray(input.modifierOptionIds)
      ? input.modifierOptionIds.map(String)
      : [];
    const modifiers = [];
    for (const oid of optionIds) {
      const entry = ctx.optionIndex.get(oid);
      if (!entry || entry.itemId !== item.id) {
        return `Option ${oid} isn't valid for ${item.name}. Choose from its listed options.`;
      }
      modifiers.push({ optionId: oid, name: entry.option.name, price: entry.option.price });
    }

    // Enforce required modifier groups so we never stage an invalid line.
    const missing = item.modifierGroups
      .filter((g) => g.required && g.min > 0)
      .filter((g) => {
        const chosen = g.options.filter((o) => optionIds.includes(o.id)).length;
        return chosen < g.min;
      })
      .map((g) => g.name);
    if (missing.length > 0) {
      return `${item.name} needs a choice for: ${missing.join(", ")}. Ask the customer, then add it.`;
    }

    const line: WaCartLine = {
      lineId: this.lineId(),
      itemId: item.id,
      name: item.name,
      quantity,
      unitBasePrice: item.price,
      modifiers,
      notes: input.notes ? String(input.notes) : undefined,
    };
    cart.items.push(line);
    return `Added ${quantity}× ${item.name}. Cart now:\n${summarizeCart(cart)}`;
  }

  private updateLine(input: any, cart: WaCart): string {
    const idx = cart.items.findIndex((l) => l.lineId === String(input.lineId));
    if (idx === -1) return `No cart line ${input.lineId}.`;
    const qty = Math.max(0, Math.round(Number(input.quantity) || 0));
    if (qty === 0) {
      const removed = cart.items.splice(idx, 1)[0];
      return `Removed ${removed?.name ?? "item"}. Cart now:\n${summarizeCart(cart)}`;
    }
    const line = cart.items[idx];
    if (line) line.quantity = qty;
    return `Updated. Cart now:\n${summarizeCart(cart)}`;
  }

  private setFulfillment(input: any, cart: WaCart): string {
    const type = input.type === "PICKUP" ? "PICKUP" : "DELIVERY";
    cart.fulfillmentType = type;
    if (type === "DELIVERY") {
      if (input.line1 || input.postcode || input.city) {
        cart.deliveryAddress = {
          line1: String(input.line1 ?? ""),
          line2: input.line2 ? String(input.line2) : undefined,
          city: String(input.city ?? ""),
          postcode: String(input.postcode ?? ""),
          country: "GB",
        };
      }
      return cart.deliveryAddress
        ? `Set to delivery. Address on file: ${[
            cart.deliveryAddress.line1,
            cart.deliveryAddress.city,
            cart.deliveryAddress.postcode,
          ]
            .filter(Boolean)
            .join(", ")}`
        : "Set to delivery. Ask the customer for their full address.";
    }
    cart.deliveryAddress = undefined;
    return "Set to pickup.";
  }

  private showMenu(input: any, ctx: WaMenuContext): { result: string; present: Presentation } {
    const category = input.category ? String(input.category).toLowerCase() : null;
    const items = category
      ? ctx.items.filter((i) => i.categoryName.toLowerCase() === category)
      : ctx.items;
    const rows = items.slice(0, 10).map((i) => ({
      id: `item:${i.id}`,
      title: i.name,
      description: `£${i.price.toFixed(2)}${i.description ? ` — ${i.description}` : ""}`,
    }));
    if (rows.length === 0) {
      return { result: "No items matched — nothing to show.", present: undefined as any };
    }
    return {
      result: `Showing ${rows.length} item(s) to the customer.`,
      present: {
        kind: "list",
        body: String(input.body ?? "Here's our menu:"),
        buttonLabel: "View items",
        header: category ? input.category : "Menu",
        sections: [{ title: category ? input.category : "Popular", rows }],
      },
    };
  }

  private showButtons(input: any): { result: string; present: Presentation } {
    const buttons = (Array.isArray(input.buttons) ? input.buttons : [])
      .slice(0, 3)
      .map((b: any) => ({ id: String(b.id ?? b.title), title: String(b.title ?? "") }))
      .filter((b: any) => b.title);
    if (buttons.length === 0) {
      return {
        result: "No valid buttons — reply with text instead.",
        present: undefined as any,
      };
    }
    return {
      result: "Buttons shown to the customer.",
      present: { kind: "buttons", body: String(input.body ?? ""), buttons },
    };
  }

  private checkout(ctx: WaMenuContext, cart: WaCart): string {
    if (cart.items.length === 0) return "Cart is empty — nothing to check out.";
    if (cart.fulfillmentType === "DELIVERY" && !cart.deliveryAddress) {
      return "Delivery selected but no address yet — ask for the full delivery address first.";
    }
    // P3 will create the order via OrdersService.ingestCanonical here and
    // return a confirmation + (P4) a Stripe payment link. For now, stage it.
    const total = cartSubtotal(cart);
    return [
      "Cart is valid and ready to confirm.",
      `Items: ${cartItemCount(cart)} | Subtotal: £${total.toFixed(2)} | ${cart.fulfillmentType}`,
      "Tell the customer their order is being placed and confirm the total. (Order creation + payment land in the next phase.)",
    ].join("\n");
  }

  // ── System prompt ────────────────────────────────────────────────────────
  private systemPrompt(ctx: WaMenuContext, cart: WaCart): string {
    return [
      `You are the ordering assistant for ${ctx.locationName}, taking orders over WhatsApp.`,
      "Be warm, brief, and natural — this is a chat, not a form. Reply with short messages.",
      "",
      "How to work:",
      "- Understand what the customer wants and map it to the menu below. Use item ids in tool calls; never invent items or prices.",
      "- When an item has REQUIRED modifier groups, ask the customer to choose before adding it. Offer the options.",
      "- Add items with add_to_cart, adjust with update_line, set delivery/pickup with set_fulfillment.",
      "- Use show_menu to let them browse, and show_buttons for quick choices (e.g. Checkout / Add more).",
      "- When they're ready and you have items + fulfillment (+ address for delivery), call checkout.",
      "- Confirm the running total in pounds (£). Only state prices that come from the menu or cart state.",
      "- Respond ONLY with the customer-facing message — no internal reasoning, no markdown headings.",
      "",
      "=== LIVE MENU ===",
      this.menu.renderMenuForAi(ctx),
      "",
      "=== CURRENT CART ===",
      summarizeCart(cart),
    ].join("\n");
  }

  // ── helpers ───────────────────────────────────────────────────────────────
  private coerceHistory(raw: unknown): TranscriptTurn[] {
    if (!Array.isArray(raw)) return [];
    return raw
      .filter((t: any) => t && (t.role === "user" || t.role === "assistant") && typeof t.content === "string")
      .map((t: any) => ({ role: t.role, content: t.content }))
      .slice(-HISTORY_LIMIT);
  }

  private lineId(): string {
    return "ln_" + Math.random().toString(36).slice(2, 10);
  }
}
