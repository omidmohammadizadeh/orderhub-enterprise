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

// Ordering is light NLU — Haiku 4.5 handles it well at ~1/5 the cost of Opus.
// Override with WHATSAPP_MODEL (e.g. claude-sonnet-4-6 / claude-opus-4-8).
const DEFAULT_MODEL = "claude-haiku-4-5";
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

// Deterministic navigation commands — handled in code so they always work,
// regardless of what the model decides. Matched against the trimmed, lowercased
// inbound text (trailing punctuation stripped).
const RESET_CMDS = new Set([
  "reset",
  "restart",
  "start over",
  "start again",
  "cancel",
  "cancel order",
  "clear",
  "clear cart",
  "exit",
  "exit chat",
  "quit",
  "stop",
]);
const MENU_CMDS = new Set([
  "menu",
  "back",
  "go back",
  "return to menu",
  "back to menu",
  "show menu",
  "show me menu",
  "show me the menu",
  "view menu",
  "see menu",
  "browse",
  "browse menu",
  "order",
  "i want to order",
  "start order",
]);
// Greetings open with the menu too — but the model often just says "tap below"
// without actually sending the list, so we send it deterministically.
const GREETING_CMDS = new Set([
  "hi",
  "hii",
  "hiya",
  "hey",
  "heya",
  "hello",
  "hello there",
  "hi there",
  "yo",
  "start",
  "get started",
  "good morning",
  "good afternoon",
  "good evening",
]);

@Injectable()
export class WhatsAppAiService {
  private readonly logger = new Logger(WhatsAppAiService.name);
  private readonly anthropic: Anthropic | null;
  private readonly model: string;
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
    // Model is configurable so cost can be tuned (ordering is light NLU —
    // Haiku 4.5 / Sonnet 4.6 handle it well at a fraction of Opus's cost).
    this.model = this.config.get<string>("WHATSAPP_MODEL") || DEFAULT_MODEL;
    this.flowId = this.config.get<string>("WHATSAPP_FLOW_ID") || undefined;
    this.flowMode =
      this.config.get<string>("WHATSAPP_FLOW_MODE") === "published" ? "published" : "draft";
  }

  /**
   * The native Flow form can only be sent once the Flow is PUBLISHED (which
   * requires Business Verification — draft sends are "Blocked by Integrity").
   * Until then we fall back to step-by-step option lists.
   */
  private get flowsEnabled(): boolean {
    return !!this.flowId && this.flowMode === "published";
  }

  /** Only send a photo when the menu has a real https image URL (WhatsApp rejects others). */
  private imageFor(item: WaMenuContext["items"][number]): { imageUrl: string; caption?: string }[] {
    return item.imageUrl && /^https:\/\//i.test(item.imageUrl)
      ? [{ imageUrl: item.imageUrl, caption: this.itemCaption(item) }]
      : [];
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

    // ── Deterministic commands (reset / back to menu) ─────────────────────
    const cmd = text.trim().toLowerCase().replace(/[!.?]+$/, "");
    if (RESET_CMDS.has(cmd)) {
      await this.sendMenuList(
        phoneNumberId,
        from,
        ctx,
        "Starting fresh 🧹 Your order's been cleared. Tap an item to begin.",
      );
      await this.prisma.whatsAppConversation.update({
        where: { id: convo.id },
        data: {
          cart: emptyCart() as any,
          messages: [] as any,
          state: "BROWSING",
          lastOutboundAt: new Date(),
        },
      });
      return;
    }
    if (MENU_CMDS.has(cmd) || GREETING_CMDS.has(cmd)) {
      cart.pending = undefined; // abandon any in-progress customisation
      const body = GREETING_CMDS.has(cmd)
        ? `Hi! 😊 Welcome to ${ctx.locationName}. Here's our menu — tap a category to start 👇`
        : "Here's the menu 👇 Pick a category.";
      await this.sendMenuList(phoneNumberId, from, ctx, body);
      await this.persistTurn(convo.id, history, text, "[Showed the menu]", cart, profileName, convo.customerName);
      return;
    }
    // Category tapped → show that category's items.
    if (text.startsWith("cat:")) {
      cart.pending = undefined;
      const categoryName = text.slice(4);
      const { present } = this.itemsList(ctx, categoryName, `Our ${categoryName} 👇 Tap to choose.`);
      if (present && present.kind === "list") {
        await this.send.sendList(phoneNumberId, from, present.body, present.buttonLabel, present.sections, present.header);
      } else {
        await this.send.sendText(phoneNumberId, from, `Sorry, nothing in ${categoryName} right now.`);
      }
      await this.persistTurn(convo.id, history, `[Customer opened category ${categoryName}]`, `[Showed ${categoryName} items]`, cart, profileName, convo.customerName);
      return;
    }

    // ── Modifier wizard: option tap (deterministic — no AI, never loops) ───
    // Asks each group once, in order, then adds to cart. Self-recovers if the
    // pending state was lost (e.g. an option tapped after a redeploy).
    if (text.startsWith("opt:") || text.startsWith("skip:")) {
      if (!cart.pending && text.startsWith("opt:")) {
        const entry = ctx.optionIndex.get(text.slice(4));
        const item = entry ? ctx.itemIndex.get(entry.itemId) : undefined;
        if (item && this.wizardEligible(item)) this.beginCustomisation(item, cart);
      }
      if (cart.pending) {
        const { ask, doneBody } = this.wizardStep(text, ctx, cart);
        if (ask && ask.kind === "list") {
          await this.send.sendList(phoneNumberId, from, ask.body, ask.buttonLabel, ask.sections, ask.header);
          await this.persistTurn(convo.id, history, text, "[Asked next option group]", cart, profileName, convo.customerName);
        } else {
          const body = doneBody ?? "Done.";
          await this.send.sendButtons(phoneNumberId, from, body, this.cartButtons());
          await this.persistTurn(convo.id, history, text, body, cart, profileName, convo.customerName);
        }
        return;
      }
    }

    // ── Item tapped → form (if unlocked), else deterministic option wizard ─
    if (text.startsWith("item:")) {
      const item = ctx.itemIndex.get(text.slice(5));
      if (item) {
        // Native form when published (Business Verification done).
        if (this.flowsEnabled && this.flowEligible(item)) {
          for (const img of this.imageFor(item)) {
            await this.send.sendImage(phoneNumberId, from, img.imageUrl, img.caption);
          }
          await this.send.sendFlow(phoneNumberId, from, {
            flowId: this.flowId!,
            flowToken: `item_${item.id}`,
            cta: "Customise",
            header: item.name,
            body: `Customise your ${item.name} — pick your options, then tap Add to cart.`,
            screen: "CUSTOMISE",
            data: this.buildFlowData(item),
            mode: this.flowMode,
          });
          await this.persistTurn(convo.id, history, `[Customer opened ${item.name}]`, `[Sent the Customise form for ${item.name}]`, cart, profileName, convo.customerName);
          return;
        }
        // Single-select options → deterministic group-by-group wizard.
        if (this.wizardEligible(item)) {
          const { present, images } = this.beginCustomisation(item, cart);
          for (const img of images) {
            await this.send.sendImage(phoneNumberId, from, img.imageUrl, img.caption);
          }
          if (present && present.kind === "list") {
            await this.send.sendList(phoneNumberId, from, present.body, present.buttonLabel, present.sections, present.header);
          }
          await this.persistTurn(convo.id, history, `[Customer opened ${item.name}]`, `[Customising ${item.name}]`, cart, profileName, convo.customerName);
          return;
        }
        // No options → add straight away.
        if (item.modifierGroups.length === 0) {
          for (const img of this.imageFor(item)) {
            await this.send.sendImage(phoneNumberId, from, img.imageUrl, img.caption);
          }
          this.addToCart({ itemId: item.id, quantity: 1, modifierOptionIds: [] }, ctx, cart);
          const body = `✅ Added ${item.name}.\n\n${summarizeCart(cart)}`;
          await this.send.sendButtons(phoneNumberId, from, body, this.cartButtons());
          await this.persistTurn(convo.id, history, `[Customer added ${item.name}]`, body, cart, profileName, convo.customerName);
          return;
        }
        // Otherwise (pick-many groups) fall through to the AI.
      }
    }

    // Free text reaching the AI — abandon any half-finished tap customisation.
    cart.pending = undefined;

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
      // Split the system prompt: the rules + full menu are STATIC per location
      // and prompt-cached (charged ~once, then ~90% cheaper on every repeat
      // call/loop iteration); only the small cart block is volatile.
      const system: Anthropic.TextBlockParam[] = [
        {
          type: "text",
          text: this.staticSystem(ctx),
          cache_control: { type: "ephemeral" },
        },
        { type: "text", text: `=== CURRENT CART ===\n${summarizeCart(cart)}` },
      ];

      for (let i = 0; i < MAX_TURN_ITERATIONS; i++) {
        const response = await this.anthropic.messages.create({
          model: this.model,
          max_tokens: 1024,
          system,
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
          flowId: this.flowId!,
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
      { id: "reset", title: "Start over" },
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

  /** Send the menu as a tappable list (used by the menu/back/reset commands). */
  private async sendMenuList(
    phoneNumberId: string,
    from: string,
    ctx: WaMenuContext,
    body: string,
  ): Promise<void> {
    const { present } = this.showMenu({ body }, ctx);
    if (present && present.kind === "list") {
      await this.send.sendList(
        phoneNumberId,
        from,
        present.body,
        present.buttonLabel,
        present.sections,
        present.header,
      );
    } else {
      await this.send.sendText(phoneNumberId, from, body);
    }
  }

  /** Can this item's options be fully captured by the radio-only Flow form? */
  private flowEligible(item: WaMenuContext["items"][number]): boolean {
    const groups = item.modifierGroups;
    if (groups.length === 0 || groups.length > FLOW_GROUP_SLOTS) return false;
    return groups.every((g) => g.selectionType === "VARIANT" || g.max === 1);
  }

  // ── Deterministic modifier wizard (no AI; never loops) ───────────────────

  /** Item whose option groups are all single-select → drive group-by-group. */
  private wizardEligible(item: WaMenuContext["items"][number]): boolean {
    return (
      item.modifierGroups.length > 0 &&
      item.modifierGroups.every((g) => g.selectionType === "VARIANT" || g.max === 1)
    );
  }

  private cartButtons(): { id: string; title: string }[] {
    return [
      { id: "checkout", title: "Checkout" },
      { id: "menu", title: "Add more" },
      { id: "reset", title: "Start over" },
    ];
  }

  /** Start customising an item: set pending state + return the first group picker. */
  private beginCustomisation(
    item: WaMenuContext["items"][number],
    cart: WaCart,
  ): { present?: Presentation; images: { imageUrl: string; caption?: string }[] } {
    const groups = item.modifierGroups;
    cart.pending = { itemId: item.id, groupIds: groups.map((g) => g.id), chosen: {} };
    const first = groups[0];
    return {
      present: first ? this.groupPickerPresent(item, first) : undefined,
      images: this.imageFor(item),
    };
  }

  /** Build a tappable list for one modifier group (rows = opt:<id>, + Skip if optional). */
  private groupPickerPresent(
    item: WaMenuContext["items"][number],
    group: WaMenuContext["items"][number]["modifierGroups"][number],
  ): Presentation {
    const max = group.required ? 10 : 9;
    const rows = group.options.slice(0, max).map((o) => ({
      id: `opt:${o.id}`,
      title: o.name,
      ...(o.price ? { description: `+£${o.price.toFixed(2)}` } : {}),
    }));
    if (!group.required) {
      rows.push({ id: `skip:${group.id}`, title: `No ${group.name}`.slice(0, 24) } as any);
    }
    return {
      kind: "list",
      body: `Pick your ${group.name}`,
      buttonLabel: "Choose",
      header: group.name.slice(0, 60),
      sections: [{ title: group.name.slice(0, 24), rows }],
    };
  }

  private nextUnansweredGroup(
    item: WaMenuContext["items"][number],
    pending: NonNullable<WaCart["pending"]>,
  ) {
    const gid = pending.groupIds.find((id) => !(id in pending.chosen));
    return gid ? item.modifierGroups.find((g) => g.id === gid) : undefined;
  }

  /** Process an option/skip tap: record it, ask the next group, or finalise. */
  private wizardStep(
    text: string,
    ctx: WaMenuContext,
    cart: WaCart,
  ): { ask?: Presentation; doneBody?: string } {
    const pending = cart.pending;
    if (!pending) return {};
    const item = ctx.itemIndex.get(pending.itemId);
    if (!item) {
      cart.pending = undefined;
      return { doneBody: "Sorry, that item is no longer available." };
    }
    if (text.startsWith("opt:")) {
      const optId = text.slice(4);
      const entry = ctx.optionIndex.get(optId);
      if (entry && entry.itemId === item.id && pending.groupIds.includes(entry.groupId)) {
        pending.chosen[entry.groupId] = optId; // records (or changes) the choice
      }
    } else if (text.startsWith("skip:")) {
      const gid = text.slice(5);
      const group = item.modifierGroups.find((g) => g.id === gid);
      if (group && !group.required) pending.chosen[gid] = "";
    }

    const next = this.nextUnansweredGroup(item, pending);
    if (next) return { ask: this.groupPickerPresent(item, next) };

    // All groups decided → add to cart.
    const optionIds = Object.values(pending.chosen).filter((v) => v);
    const before = cart.items.length;
    const result = this.addToCart(
      { itemId: item.id, quantity: 1, modifierOptionIds: optionIds },
      ctx,
      cart,
    );
    cart.pending = undefined;
    if (cart.items.length === before) return { doneBody: result };
    return { doneBody: `✅ Added ${item.name}.\n\n${summarizeCart(cart)}` };
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
          "Show a tappable list. With no category, shows the list of CATEGORIES to browse (the menu is too big for one list). Pass a category name to show that category's items. Use when the customer wants to browse or asks what's available. Tapping a category or item is handled automatically.",
        input_schema: {
          type: "object",
          properties: {
            body: { type: "string", description: "Short message shown above the list" },
            category: {
              type: "string",
              description: "Optional exact category name to show that category's items",
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
        return this.openItemForm(input, ctx, cart);
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
        imageSends.push(...this.imageFor(item));
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
    const images = this.imageFor(item);
    return {
      result: `Showing ${item.name}${images.length ? " with its photo" : " (no photo on file)"}. Option groups: ${groups}.`,
      images,
    };
  }

  private openItemForm(
    input: any,
    ctx: WaMenuContext,
    cart: WaCart,
  ): { result: string; present?: Presentation; images?: { imageUrl: string; caption?: string }[] } {
    const item = ctx.itemIndex.get(String(input.itemId));
    if (!item) return { result: `No menu item with id ${input.itemId}.` };
    // Native form when published (after Business Verification).
    if (this.flowsEnabled && this.flowEligible(item)) {
      return {
        result: `Opening the Customise form for ${item.name}. The customer picks options and taps Add to cart; you'll be told when it's added.`,
        images: this.imageFor(item),
        present: {
          kind: "flow",
          itemId: item.id,
          header: item.name,
          body: `Customise your ${item.name} — pick your options, then tap Add to cart.`,
        },
      };
    }
    // Otherwise start the deterministic group-by-group wizard (no AI loop).
    if (this.wizardEligible(item)) {
      const { present, images } = this.beginCustomisation(item, cart);
      return {
        result: `Started options for ${item.name}. The customer is choosing group-by-group and it will be added automatically — do not ask about its options.`,
        present,
        images,
      };
    }
    return {
      result: `${item.name} has no simple options — add it with add_to_cart, or use show_options for its groups.`,
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

  // show_menu: with a category → that category's items; without → a list of
  // categories to browse (WhatsApp lists cap at 10 rows, so a full menu must be
  // browsed by category rather than dumped into one list).
  private showMenu(input: any, ctx: WaMenuContext): { result: string; present?: Presentation } {
    if (input.category) {
      return this.itemsList(ctx, String(input.category), String(input.body ?? `Our ${input.category} 👇`));
    }
    return this.categoryList(ctx, String(input.body ?? "Here's our menu — pick a category 👇"));
  }

  private categoryList(ctx: WaMenuContext, body: string): { result: string; present?: Presentation } {
    const names: string[] = [];
    const seen = new Set<string>();
    for (const it of ctx.items) {
      if (!seen.has(it.categoryName)) {
        seen.add(it.categoryName);
        names.push(it.categoryName);
      }
    }
    // Single category (or none) — skip straight to items.
    if (names.length <= 1) {
      return this.itemsList(ctx, names[0] ?? "", body);
    }
    const rows = names.slice(0, 10).map((n) => ({
      id: `cat:${n}`,
      title: n,
      description: `${ctx.items.filter((i) => i.categoryName === n).length} item(s)`,
    }));
    return {
      result: `Showing ${rows.length} categories${names.length > 10 ? ` (of ${names.length})` : ""}.`,
      present: {
        kind: "list",
        body,
        buttonLabel: "Categories",
        header: "Menu",
        sections: [{ rows }],
      },
    };
  }

  private itemsList(
    ctx: WaMenuContext,
    categoryName: string,
    body: string,
  ): { result: string; present?: Presentation } {
    const cat = categoryName.toLowerCase();
    const items = cat
      ? ctx.items.filter((i) => i.categoryName.toLowerCase() === cat)
      : ctx.items;
    const rows = items.slice(0, 10).map((i) => ({
      id: `item:${i.id}`,
      title: i.name,
      description: `£${i.price.toFixed(2)}${i.description ? ` — ${i.description}` : ""}`,
    }));
    if (rows.length === 0) {
      return { result: `No items found in ${categoryName || "the menu"}.`, present: undefined };
    }
    return {
      result: `Showing ${rows.length} item(s)${items.length > 10 ? ` (of ${items.length})` : ""} in ${categoryName || "the menu"}.`,
      present: {
        kind: "list",
        body,
        buttonLabel: "View items",
        header: (categoryName || "Menu").slice(0, 60),
        sections: [{ title: (categoryName || "Items").slice(0, 24), rows }],
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

  // ── System prompt (static part — cached; the cart is sent separately) ────
  private staticSystem(ctx: WaMenuContext): string {
    return [
      `You are the ordering assistant for ${ctx.locationName}, taking orders over WhatsApp.`,
      "Be warm but BRIEF and DECISIVE — 1-2 short sentences per reply. Don't ask permission for obvious next steps, don't offer to 'pick it up later', and never re-ask something already answered. Just do the helpful thing.",
      "",
      "How to work:",
      "- The words menu / back / start over / cancel are handled automatically before you see them — don't worry about navigation.",
      "- At decision points (e.g. after adding an item) offer quick-reply buttons with show_buttons: typically Checkout, Add more, and Start over (id 'reset').",
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
