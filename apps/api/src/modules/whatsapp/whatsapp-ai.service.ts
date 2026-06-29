import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import Anthropic from "@anthropic-ai/sdk";
import type { CanonicalOrder } from "@orderhub/shared";
import { PrismaService } from "../../infrastructure/database/prisma.service";
import { OrdersService } from "../orders/orders.service";
import { PaymentsService } from "../payments/payments.service";
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
  lineUnitPrice,
  lineTotal,
  round2,
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
const CHECKOUT_CMDS = new Set([
  "checkout",
  "pay",
  "pay now",
  "place order",
  "place my order",
  "order now",
  "confirm order",
  "confirm",
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
    private readonly orders: OrdersService,
    private readonly payments: PaymentsService,
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

    const cmd = text.trim().toLowerCase().replace(/[!.?]+$/, "");

    // ── Hard reset OR a greeting → always restart from a clean slate ──────
    // A greeting ("hi", "hello", …) means a new visit: wipe the old cart and
    // re-ask collection/delivery so a returning customer never inherits items
    // or modifier picks from a previous order.
    if (RESET_CMDS.has(cmd) || GREETING_CMDS.has(cmd)) {
      await this.startFulfilment(phoneNumberId, from, convo.id, ctx);
      return;
    }

    // ── Collection / delivery choice (up-front, before the menu) ──────────
    if (text === "fulfil:pickup" || text === "fulfil:delivery") {
      const fresh = emptyCart();
      if (text === "fulfil:pickup") {
        fresh.fulfillmentType = "PICKUP";
        fresh.fulfillmentChosen = true;
        await this.prisma.whatsAppConversation.update({
          where: { id: convo.id },
          data: { cart: fresh as any, state: "ORDERING", lastOutboundAt: new Date() },
        });
        await this.sendMenuList(phoneNumberId, from, ctx, "Collection it is 🛍️ Here's our menu — pick a category 👇");
      } else {
        fresh.fulfillmentType = "DELIVERY";
        await this.prisma.whatsAppConversation.update({
          where: { id: convo.id },
          data: { cart: fresh as any, state: "ASK_ADDRESS", lastOutboundAt: new Date() },
        });
        await this.send.sendText(
          phoneNumberId,
          from,
          "Delivery 🛵 What's your address? Please send your *house number and street* (e.g. 12 High Street).",
        );
      }
      return;
    }

    // ── Delivery address capture (plain-text replies only) ────────────────
    const plainText =
      !/^(fulfil:|item:|cat:|opt:|skip:|wizback|rm:|editcart)/.test(text) &&
      !MENU_CMDS.has(cmd) &&
      !GREETING_CMDS.has(cmd);
    if (convo.state === "ASK_ADDRESS" && plainText) {
      cart.deliveryAddress = { line1: text.trim(), city: "", postcode: "", country: "GB" };
      await this.prisma.whatsAppConversation.update({
        where: { id: convo.id },
        data: { cart: cart as any, state: "ASK_POSTCODE", lastOutboundAt: new Date() },
      });
      await this.send.sendText(phoneNumberId, from, "Thanks! 📮 And your postcode?");
      return;
    }
    if (convo.state === "ASK_POSTCODE" && plainText) {
      if (!cart.deliveryAddress) cart.deliveryAddress = { line1: "", city: "", postcode: "", country: "GB" };
      cart.deliveryAddress.postcode = text.trim().toUpperCase();
      cart.fulfillmentChosen = true;
      await this.prisma.whatsAppConversation.update({
        where: { id: convo.id },
        data: { cart: cart as any, state: "ORDERING", lastOutboundAt: new Date() },
      });
      await this.sendMenuList(phoneNumberId, from, ctx, "Great, thanks! 📍 Here's our menu — pick a category 👇");
      return;
    }

    // ── Not onboarded yet → ask collection/delivery first ─────────────────
    if (!cart.fulfillmentChosen) {
      await this.startFulfilment(phoneNumberId, from, convo.id, ctx);
      return;
    }

    // ── Menu (already onboarded) → show the menu, keep the cart ───────────
    // (Greetings are handled at the top as a full reset.)
    if (MENU_CMDS.has(cmd)) {
      cart.pending = undefined;
      await this.sendMenuList(phoneNumberId, from, ctx, "Here's the menu 👇 Pick a category.");
      await this.persistTurn(convo.id, history, text, "[Showed the menu]", cart, profileName, convo.customerName);
      return;
    }

    // ── Checkout (card-only) → create the order + send a Stripe pay link ──
    if (text === "checkout" || CHECKOUT_CMDS.has(cmd)) {
      await this.handleCheckout(phoneNumberId, from, convo, cart, ctx, profileName);
      return;
    }

    // ── Edit cart → list the items so the customer can remove one ─────────
    if (text === "editcart" || cmd === "edit cart" || cmd === "edit") {
      cart.pending = undefined;
      if (cart.items.length === 0) {
        await this.send.sendText(phoneNumberId, from, "Your cart's empty 🛒 Reply *menu* to add items.");
      } else {
        const rows = cart.items.map((l, i) => ({
          id: `rm:${i}`,
          title: `${l.quantity}× ${l.name}`,
          description: `£${lineTotal(l).toFixed(2)} — tap to remove`,
        }));
        await this.send.sendList(
          phoneNumberId,
          from,
          "Tap an item to remove it from your order 👇",
          "Remove item",
          [{ title: "Your items", rows }],
          "Edit cart",
        );
      }
      await this.persistTurn(convo.id, history, text, "[Showed edit cart]", cart, profileName, convo.customerName);
      return;
    }

    // ── Remove a specific cart line (rm:<index>) ──────────────────────────
    if (text.startsWith("rm:")) {
      const idx = parseInt(text.slice(3), 10);
      if (!Number.isNaN(idx) && cart.items[idx]) {
        const removed = cart.items[idx].name;
        cart.items.splice(idx, 1);
        cart.pending = undefined;
        if (cart.items.length === 0) {
          await this.send.sendText(phoneNumberId, from, `Removed *${removed}*. Your cart's empty now 🛒 Reply *menu* to add items.`);
        } else {
          await this.sendCartActions(phoneNumberId, from, `Removed *${removed}*.\n\n${summarizeCart(cart)}`);
        }
        await this.persistTurn(convo.id, history, text, `[Removed ${removed}]`, cart, profileName, convo.customerName);
      } else {
        await this.send.sendText(phoneNumberId, from, "That item's no longer in your cart.");
      }
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
    if (
      text.startsWith("opt:") ||
      text.startsWith("skip:") ||
      text === "wizback" ||
      text === "wizdone"
    ) {
      if (!cart.pending && text.startsWith("opt:")) {
        const entry = ctx.optionIndex.get(text.slice(4));
        const item = entry ? ctx.itemIndex.get(entry.itemId) : undefined;
        if (item && this.wizardEligible(item)) this.beginCustomisation(item, cart);
      }
      if (cart.pending) {
        const { ask, doneBody, cancel } = this.wizardStep(text, ctx, cart);
        if (cancel) {
          await this.sendMenuList(phoneNumberId, from, ctx, "No problem 👍 Here's the menu — pick a category.");
          await this.persistTurn(convo.id, history, text, "[Cancelled item]", cart, profileName, convo.customerName);
        } else if (ask && ask.kind === "list") {
          await this.send.sendList(phoneNumberId, from, ask.body, ask.buttonLabel, ask.sections, ask.header);
          await this.persistTurn(convo.id, history, text, "[Asked next option group]", cart, profileName, convo.customerName);
        } else {
          const body = doneBody ?? "Done.";
          await this.sendCartActions(phoneNumberId, from, body);
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
          // Full item details (WhatsApp list rows cap descriptions at 72 chars).
          await this.send.sendText(
            phoneNumberId,
            from,
            `*${item.name}* — £${item.price.toFixed(2)}${item.description ? `\n${item.description}` : ""}`,
          );
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
          await this.sendCartActions(phoneNumberId, from, body);
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
    await this.sendCartActions(phoneNumberId, from, body);
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

  /** Greet + ask collection/delivery; resets the conversation to a fresh start. */
  private async startFulfilment(
    phoneNumberId: string,
    from: string,
    convoId: string,
    ctx: WaMenuContext,
  ): Promise<void> {
    await this.prisma.whatsAppConversation.update({
      where: { id: convoId },
      data: {
        cart: emptyCart() as any,
        messages: [] as any,
        state: "FULFILMENT",
        lastOutboundAt: new Date(),
      },
    });
    await this.send.sendButtons(
      phoneNumberId,
      from,
      `Welcome to ${ctx.locationName}! 👋 Would you like to order for collection or delivery?`,
      [
        { id: "fulfil:pickup", title: "Collection" },
        { id: "fulfil:delivery", title: "Delivery" },
      ],
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

  /** Any item with option groups is handled by the deterministic wizard. */
  private wizardEligible(item: WaMenuContext["items"][number]): boolean {
    return item.modifierGroups.length > 0;
  }

  /** Cart summary + the manage-order actions. A LIST (not buttons) so all four
   *  actions fit — WhatsApp caps reply buttons at 3. */
  private async sendCartActions(
    phoneNumberId: string,
    from: string,
    body: string,
  ): Promise<void> {
    await this.send.sendList(
      phoneNumberId,
      from,
      body,
      "Options",
      [
        {
          title: "Manage order",
          rows: [
            { id: "checkout", title: "✅ Checkout", description: "Pay & place your order" },
            { id: "menu", title: "➕ Add more items", description: "Back to the menu" },
            { id: "editcart", title: "✏️ Edit cart", description: "Remove an item" },
            { id: "reset", title: "🔄 Start over", description: "Clear cart & restart" },
          ],
        },
      ],
    );
  }

  private isMultiSelect(g: WaMenuContext["items"][number]["modifierGroups"][number]): boolean {
    return !(g.selectionType === "VARIANT" || g.max === 1);
  }

  /** Start customising an item: set pending state + return the first group picker. */
  private beginCustomisation(
    item: WaMenuContext["items"][number],
    cart: WaCart,
  ): { present?: Presentation; images: { imageUrl: string; caption?: string }[] } {
    const groups = item.modifierGroups;
    cart.pending = { itemId: item.id, groupIds: groups.map((g) => g.id), chosen: {}, done: [] };
    const first = groups[0];
    return {
      present: first ? this.groupPickerPresent(item, first, []) : undefined,
      images: this.imageFor(item),
    };
  }

  /** Build the tappable list for one modifier group. Single-select completes on
   *  tap; multi-select accumulates (✅) until "Done". Always has Back. */
  private groupPickerPresent(
    item: WaMenuContext["items"][number],
    group: WaMenuContext["items"][number]["modifierGroups"][number],
    selected: string[],
  ): Presentation {
    const multi = this.isMultiSelect(group);
    const reserve = 1 /* back */ + (multi ? 1 /* done */ : group.required ? 0 : 1 /* skip */);
    const rows: { id: string; title: string; description?: string }[] = group.options
      .slice(0, 10 - reserve)
      .map((o) => ({
        id: `opt:${o.id}`,
        title: `${selected.includes(o.id) ? "✅ " : ""}${o.name}`.slice(0, 24),
        ...(o.price ? { description: `+£${o.price.toFixed(2)}` } : {}),
      }));
    if (multi) {
      rows.push({ id: "wizdone", title: group.required ? "✅ Done" : "✅ Done / none" });
    } else if (!group.required) {
      rows.push({ id: `skip:${group.id}`, title: `No ${group.name}`.slice(0, 24) });
    }
    rows.push({ id: "wizback", title: "⬅️ Back" });
    const body = multi
      ? `${group.name} — tap to add${group.required ? ` (pick ${group.min}+)` : ", then Done"}`
      : `Pick your ${group.name}`;
    return {
      kind: "list",
      body: body.slice(0, 1024),
      buttonLabel: "Choose",
      header: group.name.slice(0, 60),
      sections: [{ title: group.name.slice(0, 24), rows }],
    };
  }

  /** Process an option / done / skip / back tap; ask next group or finalise. */
  private wizardStep(
    text: string,
    ctx: WaMenuContext,
    cart: WaCart,
  ): { ask?: Presentation; doneBody?: string; cancel?: boolean } {
    const pending = cart.pending;
    if (!pending) return {};
    const item = ctx.itemIndex.get(pending.itemId);
    if (!item) {
      cart.pending = undefined;
      return { doneBody: "Sorry, that item is no longer available." };
    }
    const groupById = (id?: string) => item.modifierGroups.find((g) => g.id === id);
    const curGid = pending.groupIds.find((id) => !pending.done.includes(id));
    const curGroup = groupById(curGid);

    // Back → re-open the previously completed group (or cancel at the start).
    if (text === "wizback") {
      const prevGid = pending.done.pop();
      if (!prevGid) {
        cart.pending = undefined;
        return { cancel: true };
      }
      const prev = groupById(prevGid);
      return prev
        ? { ask: this.groupPickerPresent(item, prev, pending.chosen[prevGid] ?? []) }
        : { cancel: true };
    }

    if (!curGroup || !curGid) return this.finaliseWizard(item, pending, ctx, cart);

    const sel = (pending.chosen[curGid] ??= []);

    if (text.startsWith("opt:")) {
      const optId = text.slice(4);
      if (!curGroup.options.some((o) => o.id === optId)) {
        return { ask: this.groupPickerPresent(item, curGroup, sel) }; // ignore stray tap
      }
      if (this.isMultiSelect(curGroup)) {
        const i = sel.indexOf(optId);
        if (i >= 0) sel.splice(i, 1); // toggle off
        else if (!curGroup.max || sel.length < curGroup.max) sel.push(optId);
        return { ask: this.groupPickerPresent(item, curGroup, sel) };
      }
      pending.chosen[curGid] = [optId]; // single-select → complete the group
      pending.done.push(curGid);
      return this.advance(item, pending, ctx, cart);
    }

    if (text === "wizdone" && this.isMultiSelect(curGroup)) {
      if (curGroup.required && sel.length < Math.max(1, curGroup.min)) {
        return { ask: this.groupPickerPresent(item, curGroup, sel) }; // need more
      }
      pending.done.push(curGid);
      return this.advance(item, pending, ctx, cart);
    }

    if (text.startsWith("skip:") && !curGroup.required) {
      pending.chosen[curGid] = [];
      pending.done.push(curGid);
      return this.advance(item, pending, ctx, cart);
    }

    return { ask: this.groupPickerPresent(item, curGroup, sel) }; // re-show current
  }

  private advance(
    item: WaMenuContext["items"][number],
    pending: NonNullable<WaCart["pending"]>,
    ctx: WaMenuContext,
    cart: WaCart,
  ): { ask?: Presentation; doneBody?: string; cancel?: boolean } {
    const nextGid = pending.groupIds.find((id) => !pending.done.includes(id));
    const next = item.modifierGroups.find((g) => g.id === nextGid);
    if (next && nextGid) {
      return { ask: this.groupPickerPresent(item, next, pending.chosen[nextGid] ?? []) };
    }
    return this.finaliseWizard(item, pending, ctx, cart);
  }

  private finaliseWizard(
    item: WaMenuContext["items"][number],
    pending: NonNullable<WaCart["pending"]>,
    ctx: WaMenuContext,
    cart: WaCart,
  ): { doneBody: string } {
    const optionIds = pending.groupIds.flatMap((g) => pending.chosen[g] ?? []);
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

  // ── Checkout: create the order + Stripe payment link (card only) ─────────
  // After paying, Stripe redirects here — a wa.me deep link sends the customer
  // back to the WhatsApp chat. Override per business via WHATSAPP_PAY_RETURN_URL.
  private returnUrl(): string {
    return this.config.get<string>("WHATSAPP_PAY_RETURN_URL") || "https://wa.me/15556619699";
  }

  private async handleCheckout(
    phoneNumberId: string,
    from: string,
    convo: { id: string; customerName: string | null },
    cart: WaCart,
    ctx: WaMenuContext,
    profileName?: string,
  ): Promise<void> {
    if (cart.items.length === 0) {
      await this.send.sendText(phoneNumberId, from, "Your cart's empty 🛒 Reply *menu* to start an order.");
      return;
    }
    if (cart.fulfillmentType === "DELIVERY" && !cart.deliveryAddress?.line1) {
      await this.send.sendText(phoneNumberId, from, "I still need your delivery address — reply *start over* and choose Delivery.");
      return;
    }

    // Delivery fee from the postcode zones (POS setup); enforce min order +
    // refuse postcodes outside the delivery zones.
    let deliveryFee = 0;
    const subtotal = cartSubtotal(cart);
    if (cart.fulfillmentType === "DELIVERY") {
      const postcode = cart.deliveryAddress?.postcode ?? "";
      const zone = await this.resolveDeliveryFee(ctx, postcode);
      if (zone.hasZones && !zone.matched) {
        await this.send.sendText(
          phoneNumberId,
          from,
          `Sorry, we don't deliver to *${postcode}* 😔 Reply *start over* to order for collection instead.`,
        );
        return;
      }
      if (zone.matched && zone.minOrder && subtotal < zone.minOrder) {
        const need = round2(zone.minOrder - subtotal);
        await this.send.sendText(
          phoneNumberId,
          from,
          `The minimum for delivery to *${postcode}* is £${zone.minOrder.toFixed(2)}. Please add £${need.toFixed(2)} more — reply *menu* to add items.`,
        );
        return;
      }
      deliveryFee = zone.fee;
    }

    // 1) Create the order via the canonical pipeline (card, unpaid → hidden
    //    until Stripe authorises, then it auto-accepts into the kitchen).
    let order: { id: string; displayId?: string | null };
    try {
      order = await this.orders.ingestCanonical(
        this.cartToCanonical(cart, from, convo.customerName ?? profileName, deliveryFee, phoneNumberId),
        ctx.tenantId,
        ctx.locationId,
      );
    } catch (err: any) {
      this.logger.error(`WhatsApp order create failed: ${err?.message ?? err}`);
      await this.send.sendText(phoneNumberId, from, "Sorry, something went wrong placing your order. Please try again.");
      return;
    }

    // 2) Stripe payment link (card / Apple Pay / Google Pay).
    let url: string;
    try {
      const res = await this.payments.createCheckoutSession({
        tenantId: ctx.tenantId,
        orderId: order.id,
        successUrl: this.returnUrl(),
        cancelUrl: this.returnUrl(),
      });
      url = res.url;
    } catch (err: any) {
      this.logger.error(`WhatsApp checkout session failed (location ${ctx.locationId}): ${err?.message ?? err}`);
      await this.send.sendText(
        phoneNumberId,
        from,
        "Sorry — card payment isn't set up for this location yet. Please contact the restaurant.",
      );
      return;
    }

    // Order is placed — clear the cart so the next order (or a returning
    // customer) starts from scratch and never inherits these items/options.
    await this.prisma.whatsAppConversation.update({
      where: { id: convo.id },
      data: {
        lastOrderId: order.id,
        state: "AWAITING_PAYMENT",
        cart: emptyCart() as any,
        messages: [] as any,
        lastOutboundAt: new Date(),
      },
    });

    // Service charge = the fixed application-fee surcharge Stripe adds as a
    // "Service charge" line. Show it so the quoted total matches Stripe.
    let serviceCharge = 0;
    try {
      serviceCharge = await this.payments.customerServiceChargeGbp(ctx.locationId, subtotal);
    } catch {
      serviceCharge = 0;
    }
    const total = round2(subtotal + deliveryFee + serviceCharge);
    const fulfil = cart.fulfillmentType === "DELIVERY" ? "Delivery" : "Collection";
    const feeLine = deliveryFee > 0 ? `\nDelivery fee: £${deliveryFee.toFixed(2)}` : "";
    const svcLine = serviceCharge > 0 ? `\nService charge: £${serviceCharge.toFixed(2)}` : "";
    await this.send.sendText(
      phoneNumberId,
      from,
      `✅ Order received!\n\n${summarizeCart(cart)}${feeLine}${svcLine}\n\n${fulfil} • Total *£${total.toFixed(2)}*\n\nTap to pay securely (Apple Pay, Google Pay or card) 👇\n${url}\n\nWe'll start preparing it as soon as payment's confirmed 🧑‍🍳`,
    );
  }

  /** Build a CanonicalOrder from the WhatsApp cart (card, unpaid). */
  private cartToCanonical(
    cart: WaCart,
    waPhone: string,
    name: string | null | undefined,
    deliveryFee: number,
    phoneNumberId: string,
  ): CanonicalOrder {
    const subtotal = cartSubtotal(cart);
    const total = round2(subtotal + deliveryFee);
    const rnd = Math.random().toString(36).slice(2, 8);
    return {
      externalId: `wa_${Date.now()}_${rnd}`,
      platform: "WHATSAPP",
      orderSource: "WHATSAPP",
      integrationSource: "DIRECT",
      viaHubrise: false,
      fulfillmentType: cart.fulfillmentType,
      displayId: `WA-${rnd.toUpperCase()}`,
      customerInfo: { name: name || "WhatsApp Customer", phone: waPhone },
      deliveryAddress:
        cart.fulfillmentType === "DELIVERY" && cart.deliveryAddress
          ? {
              line1: cart.deliveryAddress.line1 || "",
              line2: cart.deliveryAddress.line2,
              city: cart.deliveryAddress.city || "",
              postcode: cart.deliveryAddress.postcode || "",
              country: "GB",
            }
          : undefined,
      items: cart.items.map((l) => ({
        name: l.name,
        quantity: l.quantity,
        unitPrice: lineUnitPrice(l),
        totalPrice: lineTotal(l),
        modifiers: l.modifiers.map((m) => ({ name: m.name, price: m.price, quantity: 1 })),
        notes: l.notes,
      })),
      subtotal,
      taxAmount: 0,
      deliveryFee,
      discount: 0,
      total,
      idempotencyKey: `wa_${waPhone}_${Date.now()}`,
      metadata: {
        source: "whatsapp",
        waPhone,
        phoneNumberId,
        paymentMethod: "CARD",
        paymentStatus: "PENDING",
      },
    } as CanonicalOrder;
  }

  /** Postcode → delivery fee, mirroring the storefront (brand zones preferred,
   *  then location zones; longest-prefix match). */
  private async resolveDeliveryFee(
    ctx: WaMenuContext,
    postcode: string,
  ): Promise<{ matched: boolean; hasZones: boolean; fee: number; minOrder: number | null }> {
    const norm = (postcode || "").toUpperCase().replace(/\s+/g, "");
    const pick = async (where: Record<string, unknown>) => {
      const zones = await this.prisma.deliveryZone.findMany({
        where: { ...where, isActive: true },
        select: { postcodePrefix: true, fee: true, minOrderValue: true },
      });
      let best: { fee: number; minOrder: number | null; len: number } | null = null;
      for (const z of zones) {
        const zp = z.postcodePrefix.toUpperCase().replace(/\s+/g, "");
        if (zp && norm.startsWith(zp) && (!best || zp.length > best.len)) {
          best = {
            fee: Number(z.fee),
            minOrder: z.minOrderValue !== null ? Number(z.minOrderValue) : null,
            len: zp.length,
          };
        }
      }
      return { hasZones: zones.length > 0, best };
    };

    if (ctx.brandId) {
      const b = await pick({ brandId: ctx.brandId });
      if (b.hasZones) {
        return { matched: !!b.best, hasZones: true, fee: b.best?.fee ?? 0, minOrder: b.best?.minOrder ?? null };
      }
    }
    const l = await pick({ locationId: ctx.locationId });
    return { matched: !!l.best, hasZones: l.hasZones, fee: l.best?.fee ?? 0, minOrder: l.best?.minOrder ?? null };
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
    // Validate options against THIS item's own groups (options are shared
    // across items, so the global option index can point at another item).
    const itemOptions = new Map<string, { name: string; price: number }>();
    for (const g of item.modifierGroups) {
      for (const o of g.options) itemOptions.set(o.id, { name: o.name, price: o.price });
    }
    const modifiers = [];
    for (const oid of optionIds) {
      const opt = itemOptions.get(oid);
      if (!opt) {
        return `Option ${oid} isn't valid for ${item.name}. Choose from its listed options.`;
      }
      modifiers.push({ optionId: oid, name: opt.name, price: opt.price });
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
