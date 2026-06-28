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
    }
  | { kind: "flow"; itemId: string; header: string; body: string };

const FLOW_GROUP_SLOTS = 5; // radio groups supported by the "Customise item" Flow

@Injectable()
export class WhatsAppAiService {
  private readonly logger = new Logger(WhatsAppAiService.name);
  private readonly anthropic: Anthropic | null;
  private readonly flowId?: string;
  private readonly flowMode: "draft" | "published";

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
    this.flowId = this.config.get<string>("WHATSAPP_FLOW_ID") || undefined;
    this.flowMode =
      this.config.get<string>("WHATSAPP_FLOW_MODE") === "published" ? "published" : "draft";
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

    // ── Item tapped → open the native "Customise" form (WhatsApp Flow) ────
    // When the menu picker returns an item id and the item's options fit the
    // form (all single-select, ≤5 groups), send the Flow so the customer picks
    // everything and taps one "Add to cart" — instead of a tap-per-group chat.
    if (this.flowId && text.startsWith("item:")) {
      const item = ctx.itemIndex.get(text.slice(5));
      if (item && this.flowEligible(item)) {
        if (item.imageUrl) {
          await this.send.sendImage(phoneNumberId, from, item.imageUrl, this.itemCaption(item));
        }
        await this.send.sendFlow(phoneNumberId, from, {
          flowId: this.flowId,
          flowToken: `item_${item.id}`,
          cta: "Customise",
          header: item.name,
          body: `Customise your ${item.name} — pick your options, then tap Add to cart.`,
          screen: "CUSTOMISE",
          data: this.buildFlowData(item),
          mode: this.flowMode,
        });
        await this.persistTurn(
          convo.id,
          history,
          `[Customer opened ${item.name}]`,
          `[Sent the Customise form for ${item.name}]`,
          cart,
          profileName,
          convo.customerName,
        );
        return;
      }
    }

    // ── Decode interactive taps, then run the Claude tool loop ────────────
    // WhatsApp list/button taps arrive as our row ids (item:<id> / opt:<id>).
    // Translate them into explicit instructions so the model knows what was
    // picked, and queue the item photo to send alongside the reply.
    const imageSends: { imageUrl: string; caption?: string }[] = [];
    const userText = this.decodeInbound(text, ctx, imageSends);

    let presentation: Presentation | null = null;
    const messages: Anthropic.MessageParam[] = [
      ...history.map((t) => ({ role: t.role, content: t.content })),
      { role: "user" as const, content: userText },
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
          const { result, present, images } = this.runTool(tu.name, tu.input, ctx, cart);
          if (present) presentation = present;
          if (images) imageSends.push(...images);
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

    // ── Send any item photos first (deduped), then the reply ──────────────
    const sentImages = new Set<string>();
    for (const img of imageSends) {
      if (!img.imageUrl || sentImages.has(img.imageUrl)) continue;
      sentImages.add(img.imageUrl);
      await this.send.sendImage(phoneNumberId, from, img.imageUrl, img.caption);
    }

    // ── Send the reply (interactive presentation wins over plain text) ────
    let assistantRecord: string;
    if (presentation && presentation.kind === "flow") {
      assistantRecord = `[Sent the Customise form for ${presentation.header}]`;
      const item = ctx.itemIndex.get(presentation.itemId);
      if (this.flowId && item) {
        await this.send.sendFlow(phoneNumberId, from, {
          flowId: this.flowId,
          flowToken: `item_${item.id}`,
          cta: "Customise",
          header: presentation.header,
          body: presentation.body,
          screen: "CUSTOMISE",
          data: this.buildFlowData(item),
          mode: this.flowMode,
        });
      } else {
        assistantRecord = finalText || "What would you like?";
        await this.send.sendText(phoneNumberId, from, assistantRecord);
      }
    } else if (presentation) {
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
    await this.persistTurn(
      convo.id,
      history,
      userText,
      assistantRecord,
      cart,
      profileName,
      convo.customerName,
    );
  }

  /** Handle a completed "Customise item" Flow: add the configured item to cart. */
  async handleFlowReply(args: {
    phoneNumberId: string;
    from: string;
    responseJson: string;
    profileName?: string;
  }): Promise<void> {
    const { phoneNumberId, from, responseJson, profileName } = args;
    const ctx = await this.menu.resolveContext(phoneNumberId);
    if (!ctx) return;

    const convo = await this.prisma.whatsAppConversation.upsert({
      where: { phoneNumberId_waPhone: { phoneNumberId, waPhone: from } },
      create: {
        tenantId: ctx.tenantId,
        locationId: ctx.locationId,
        brandId: ctx.brandId ?? null,
        waPhone: from,
        phoneNumberId,
        state: "CART",
        cart: emptyCart() as any,
        customerName: profileName ?? null,
        lastInboundAt: new Date(),
      },
      update: { lastInboundAt: new Date() },
    });
    const cart = coerceCart(convo.cart);
    const history = this.coerceHistory(convo.messages);

    let parsed: Record<string, unknown> = {};
    try {
      parsed = JSON.parse(responseJson || "{}");
    } catch {
      /* ignore */
    }
    const itemId = String(parsed.item_id ?? "");
    const item = ctx.itemIndex.get(itemId);
    if (!item) {
      await this.send.sendText(phoneNumberId, from, "Sorry, that item isn't available anymore.");
      return;
    }
    const optionIds: string[] = [];
    for (let i = 0; i < FLOW_GROUP_SLOTS; i++) {
      const v = parsed[`g${i}`];
      if (v && v !== "none" && v !== "_") optionIds.push(String(v));
    }
    const notes = parsed.notes ? String(parsed.notes) : undefined;

    const before = cart.items.length;
    const result = this.addToCart({ itemId, quantity: 1, modifierOptionIds: optionIds, notes }, ctx, cart);
    if (cart.items.length === before) {
      // addToCart rejected (e.g. an option no longer valid) — surface it.
      await this.send.sendText(phoneNumberId, from, result);
      return;
    }

    const body = `✅ Added ${item.name}.\n\n${summarizeCart(cart)}`;
    await this.send.sendButtons(phoneNumberId, from, body, [
      { id: "checkout", title: "Checkout" },
      { id: "menu", title: "Add more" },
    ]);
    await this.persistTurn(
      convo.id,
      history,
      `[Customer customised ${item.name} and added it]`,
      body,
      cart,
      profileName,
      convo.customerName,
    );
  }

  /** Can this item's options be fully captured by the radio-only Flow form? */
  private flowEligible(item: WaMenuContext["items"][number]): boolean {
    const groups = item.modifierGroups;
    if (groups.length === 0 || groups.length > FLOW_GROUP_SLOTS) return false;
    return groups.every((g) => g.selectionType === "VARIANT" || g.max === 1);
  }

  /** Build the Flow screen data (g0..g4 + notes) from an item's option groups. */
  private buildFlowData(item: WaMenuContext["items"][number]): Record<string, unknown> {
    const data: Record<string, unknown> = {
      item_id: item.id,
      subtitle: (item.description ?? "Choose your options").slice(0, 80),
      notes_visible: true,
    };
    const groups = item.modifierGroups.slice(0, FLOW_GROUP_SLOTS);
    for (let i = 0; i < FLOW_GROUP_SLOTS; i++) {
      const g = groups[i];
      if (g) {
        const opts = g.options.map((o) => ({
          id: o.id,
          title: `${o.name}${o.price ? ` (+£${o.price.toFixed(2)})` : ""}`.slice(0, 30),
        }));
        if (!g.required) opts.unshift({ id: "none", title: `No ${g.name}`.slice(0, 30) });
        data[`g${i}_visible`] = true;
        data[`g${i}_label`] = g.name.slice(0, 30);
        data[`g${i}_required`] = g.required;
        data[`g${i}_options`] = opts.length ? opts : [{ id: "_", title: "-" }];
      } else {
        data[`g${i}_visible`] = false;
        data[`g${i}_label`] = "-";
        data[`g${i}_required`] = false;
        data[`g${i}_options`] = [{ id: "_", title: "-" }];
      }
    }
    return data;
  }

  /** Persist cart + rolling transcript + derived state for one turn. */
  private async persistTurn(
    convoId: string,
    history: TranscriptTurn[],
    userText: string,
    assistantText: string,
    cart: WaCart,
    profileName: string | undefined,
    existingName: string | null,
  ): Promise<void> {
    const nextHistory = [
      ...history,
      { role: "user" as const, content: userText },
      { role: "assistant" as const, content: assistantText },
    ].slice(-HISTORY_LIMIT);
    await this.prisma.whatsAppConversation.update({
      where: { id: convoId },
      data: {
        cart: cart as any,
        messages: nextHistory as any,
        state: cart.items.length > 0 ? "CART" : "BROWSING",
        lastOutboundAt: new Date(),
        ...(profileName && !existingName ? { customerName: profileName } : {}),
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
        name: "show_item",
        description:
          "Show the customer a single item's photo (if it has one) with a caption. Use when they tap or ask about a specific item, before walking through its options.",
        input_schema: {
          type: "object",
          properties: {
            itemId: { type: "string", description: "Menu item id (the [id:...] value)" },
          },
          required: ["itemId"],
        },
      },
      {
        name: "open_item_form",
        description:
          "PREFERRED for any item that has option groups: opens a native form where the customer picks ALL options (wrap, sauce, drink, etc.) and taps one 'Add to cart'. Use this the moment the customer wants such an item. If it returns that the form isn't available, fall back to show_options group-by-group.",
        input_schema: {
          type: "object",
          properties: {
            itemId: { type: "string", description: "Menu item id (the [id:...] value)" },
          },
          required: ["itemId"],
        },
      },
      {
        name: "show_options",
        description:
          "Fallback when the form isn't available: show the tappable options for ONE modifier group of an item. Use the group id ([grp:...]). Call for one group at a time until all required groups are chosen — then add_to_cart with all chosen option ids.",
        input_schema: {
          type: "object",
          properties: {
            itemId: { type: "string", description: "Menu item id" },
            groupId: { type: "string", description: "Modifier group id (the [grp:...] value)" },
            body: { type: "string", description: "Short prompt, e.g. 'Choose your sauce'" },
          },
          required: ["itemId", "groupId"],
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
  ): { result: string; present?: Presentation; images?: { imageUrl: string; caption?: string }[] } {
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
      case "show_item":
        return this.showItem(input, ctx);
      case "open_item_form":
        return this.openItemForm(input, ctx);
      case "show_options":
        return this.showOptions(input, ctx);
      case "show_buttons":
        return this.showButtons(input);
      case "checkout":
        return { result: this.checkout(ctx, cart) };
      default:
        return { result: `Unknown tool ${name}.` };
    }
  }

  /** Translate a WhatsApp tap (our row id) into an explicit instruction. */
  private decodeInbound(
    text: string,
    ctx: WaMenuContext,
    imageSends: { imageUrl: string; caption?: string }[],
  ): string {
    if (text.startsWith("item:")) {
      const item = ctx.itemIndex.get(text.slice(5));
      if (item) {
        if (item.imageUrl) {
          imageSends.push({ imageUrl: item.imageUrl, caption: this.itemCaption(item) });
        }
        const required = item.modifierGroups.filter((g) => g.required);
        const groups = item.modifierGroups
          .map((g) => `${g.name} [grp:${g.id}]${g.required ? " (required)" : ""}`)
          .join("; ");
        return required.length > 0
          ? `[The customer tapped "${item.name}" (item:${item.id}). It needs choices for: ${groups}. Walk them through each required group one at a time using show_options, then add_to_cart with all chosen options.]`
          : `[The customer tapped "${item.name}" (item:${item.id}). Confirm and add it to the cart${
              groups ? `; optional extras: ${groups}` : ""
            }.]`;
      }
    }
    if (text.startsWith("opt:")) {
      const entry = ctx.optionIndex.get(text.slice(4));
      if (entry) {
        return `[The customer selected "${entry.option.name}" (opt:${text.slice(4)}) for item ${entry.itemId}.]`;
      }
    }
    return text;
  }

  private showItem(
    input: any,
    ctx: WaMenuContext,
  ): { result: string; images?: { imageUrl: string; caption?: string }[] } {
    const item = ctx.itemIndex.get(String(input.itemId));
    if (!item) return { result: `No menu item with id ${input.itemId}.` };
    const groups =
      item.modifierGroups
        .map((g) => `${g.name} [grp:${g.id}]${g.required ? " (required)" : " (optional)"}`)
        .join("; ") || "no options";
    return {
      result: `Showing ${item.name}${item.imageUrl ? " with its photo" : " (no photo on file)"}. Option groups: ${groups}.`,
      images: item.imageUrl ? [{ imageUrl: item.imageUrl, caption: this.itemCaption(item) }] : [],
    };
  }

  private openItemForm(
    input: any,
    ctx: WaMenuContext,
  ): { result: string; present?: Presentation; images?: { imageUrl: string; caption?: string }[] } {
    const item = ctx.itemIndex.get(String(input.itemId));
    if (!item) return { result: `No menu item with id ${input.itemId}.` };
    if (!this.flowId || !this.flowEligible(item)) {
      return {
        result: `The form isn't available for ${item.name} — fall back to show_options group-by-group.`,
      };
    }
    return {
      result: `Opening the Customise form for ${item.name}. The customer will pick options and tap Add to cart; you'll be told when it's added.`,
      images: item.imageUrl ? [{ imageUrl: item.imageUrl, caption: this.itemCaption(item) }] : [],
      present: {
        kind: "flow",
        itemId: item.id,
        header: item.name,
        body: `Customise your ${item.name} — pick your options, then tap Add to cart.`,
      },
    };
  }

  private showOptions(input: any, ctx: WaMenuContext): { result: string; present?: Presentation } {
    const item = ctx.itemIndex.get(String(input.itemId));
    if (!item) return { result: `No menu item with id ${input.itemId}.` };
    const gid = String(input.groupId ?? "");
    const group =
      item.modifierGroups.find((g) => g.id === gid) ??
      item.modifierGroups.find((g) => g.name.toLowerCase() === gid.toLowerCase());
    if (!group) return { result: `No option group ${gid} on ${item.name}.` };
    const rows = group.options.slice(0, 10).map((o) => ({
      id: `opt:${o.id}`,
      title: o.name,
      ...(o.price ? { description: `+£${o.price.toFixed(2)}` } : {}),
    }));
    if (rows.length === 0) return { result: `${group.name} has no available options.` };
    const body = String(input.body ?? `Choose your ${group.name}`);
    return {
      result: `Showing ${rows.length} ${group.name} option(s) to the customer.`,
      present: {
        kind: "list",
        body,
        buttonLabel: "Choose",
        header: group.name,
        sections: [{ title: group.name, rows }],
      },
    };
  }

  private itemCaption(item: { name: string; price: number; description?: string }): string {
    return `${item.name} — £${item.price.toFixed(2)}${item.description ? `\n${item.description}` : ""}`;
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
      "- Messages in [square brackets] are system signals about taps (e.g. the customer tapped an item or chose an option) — act on them, don't repeat them back.",
      "- Browsing: use show_menu to show a tappable list of items.",
      "- When the customer wants an item that has option groups (e.g. a meal with wrap/sauce/drink), call open_item_form with its id — this opens a single form where they pick everything and tap Add to cart. You'll be told once it's added; don't ask about the options yourself.",
      "- Only if open_item_form says the form isn't available: fall back to show_options group-by-group, then add_to_cart with all chosen option ids.",
      "- For an item with NO options, just add_to_cart directly. Use show_item to show a photo when helpful.",
      "- Add items with add_to_cart, adjust with update_line, set delivery/pickup with set_fulfillment.",
      "- Use show_buttons for quick choices (e.g. Checkout / Add more / View menu).",
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
