import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import Anthropic from "@anthropic-ai/sdk";
import { PrismaService } from "../../infrastructure/database/prisma.service";
import { OrdersService } from "../orders/orders.service";
import { SmsService } from "../sms/sms.service";
import { PaymentsService } from "../payments/payments.service";
import type { VoiceContext } from "./voice-context.service";
import { normaliseNumber } from "./voice-context.service";
import {
  coerceCart,
  cartSubtotal,
  emptyCart,
  lineTotal,
  lineUnitPrice,
  round2,
  summarizeCart,
  type WaCart,
} from "../whatsapp/whatsapp-cart";

// The conversation engine for the AI phone line.
//
// The ORDERING BRAIN is shared with WhatsApp — same cart shape, same menu
// context, same OrdersService at the end. What is different, and what this file
// is really about, is that a phone call has no screen:
//
//   • no buttons, no lists, no images — every choice has to be spoken
//   • one question at a time, because a caller cannot scroll back
//   • the order must be read back before it is placed; a wrong order that gets
//     cooked is the failure that gets the AI switched off for good
//   • the caller can interrupt, change their mind mid-sentence, or ask for a
//     human — and asking for a human must always work
//
// Every design choice below follows from one of those four.

const DEFAULT_MODEL = "claude-sonnet-5";
const MAX_TOOL_ITERATIONS = 6;

/** What the telephony layer should do after this turn. */
export interface VoiceTurn {
  /** Text to speak. Never empty — silence on a phone call reads as a dropped line. */
  say: string;
  /** Hang up after speaking. */
  endCall?: boolean;
  /** Warm-transfer to this number after speaking. */
  transferTo?: string;
  /** Set once an order exists, so the call record can link to it. */
  orderId?: string;
  /** ORDER | RESERVATION | ORDER_STATUS | ENQUIRY | TRANSFERRED | ABANDONED */
  outcome?: string;
}

export interface VoiceState {
  turns: Array<{ role: "user" | "assistant"; text: string }>;
  cart: WaCart;
  /** Set once placed so we can't place twice on a re-ask. */
  orderId?: string;
  outcome?: string;
  message?: string;
}

export function emptyState(): VoiceState {
  return { turns: [], cart: emptyCart() };
}

export function coerceState(raw: unknown): VoiceState {
  if (!raw || typeof raw !== "object") return emptyState();
  const r = raw as any;
  return {
    turns: Array.isArray(r.turns)
      ? r.turns
          .filter((t: any) => t && (t.role === "user" || t.role === "assistant"))
          .map((t: any) => ({ role: t.role, text: String(t.text ?? "") }))
      : [],
    cart: coerceCart(r.cart),
    orderId: r.orderId ? String(r.orderId) : undefined,
    outcome: r.outcome ? String(r.outcome) : undefined,
    message: r.message ? String(r.message) : undefined,
  };
}

@Injectable()
export class VoiceAiService {
  private readonly logger = new Logger(VoiceAiService.name);
  private readonly anthropic: Anthropic | null;
  private readonly model: string;

  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
    private readonly orders: OrdersService,
    private readonly sms: SmsService,
    private readonly payments: PaymentsService,
  ) {
    const apiKey = this.config.get<string>("ANTHROPIC_API_KEY");
    this.anthropic = apiKey ? new Anthropic({ apiKey }) : null;
    if (!this.anthropic) {
      this.logger.warn("ANTHROPIC_API_KEY not set — AI phone line disabled");
    }
    // Latency is the binding constraint on a phone call, not raw capability:
    // a caller notices a one-second pause. Configurable so the tier can be
    // tuned against real call recordings.
    this.model = this.config.get<string>("VOICE_MODEL") || DEFAULT_MODEL;
  }

  private db(): any {
    return this.prisma as any;
  }

  /** The greeting. Deliberately code, not model output — the first thing a
   *  caller hears must be instant and identical every time. */
  greeting(ctx: VoiceContext, knownName?: string | null): string {
    const who = knownName ? `Hi ${knownName}` : "Hi";
    return `${who}, you're through to ${ctx.locationName}. I can take an order or answer a question — how can I help?`;
  }

  // ── The turn ────────────────────────────────────────────────────────────

  async respond(args: {
    ctx: VoiceContext;
    state: VoiceState;
    userText: string;
    callerNumber?: string | null;
  }): Promise<{ turn: VoiceTurn; state: VoiceState }> {
    const { ctx } = args;
    const state = args.state;
    state.turns.push({ role: "user", text: args.userText });

    if (!this.anthropic) {
      const say =
        "Sorry, I can't take your order right now. Let me put you through to the shop.";
      state.turns.push({ role: "assistant", text: say });
      return { turn: { say, transferTo: ctx.transferNumber ?? undefined, outcome: "TRANSFERRED" }, state };
    }

    let turn: VoiceTurn = { say: "" };

    try {
      const messages: Anthropic.MessageParam[] = state.turns.map((t) => ({
        role: t.role === "user" ? "user" : "assistant",
        content: t.text,
      }));

      const system: Anthropic.TextBlockParam[] = [
        {
          type: "text",
          text: this.systemPrompt(ctx),
          // The menu is re-sent on every turn of every call and is identical
          // across them. Caching it is the single biggest lever on our cost
          // per call — without it the Claude bill roughly triples.
          cache_control: { type: "ephemeral" },
        },
        { type: "text", text: `=== ORDER SO FAR ===\n${summarizeCart(state.cart)}` },
      ];

      const tools = this.toolDefs(ctx);
      let spoken = "";

      for (let i = 0; i < MAX_TOOL_ITERATIONS; i++) {
        const response = await this.anthropic.messages.create({
          model: this.model,
          max_tokens: 700,
          system,
          tools,
          messages,
        });

        const text = response.content
          .filter((b): b is Anthropic.TextBlock => b.type === "text")
          .map((b) => b.text)
          .join(" ")
          .trim();
        if (text) spoken = text;

        const toolUses = response.content.filter(
          (b): b is Anthropic.ToolUseBlock => b.type === "tool_use",
        );
        if (response.stop_reason !== "tool_use" || toolUses.length === 0) break;

        messages.push({ role: "assistant", content: response.content });
        const results: Anthropic.ToolResultBlockParam[] = [];
        for (const tu of toolUses) {
          const out = await this.runTool(tu.name, tu.input as any, ctx, state, args.callerNumber);
          if (out.turn) turn = { ...turn, ...out.turn };
          results.push({ type: "tool_result", tool_use_id: tu.id, content: out.result });
        }
        messages.push({ role: "user", content: results });
      }

      turn.say = this.speakable(spoken || turn.say);
    } catch (err: any) {
      this.logger.error(`Voice turn failed: ${err?.message ?? err}`);
      // A model failure mid-call must not become dead air. Hand to a human —
      // the caller keeps their order and the shop keeps the sale.
      turn = {
        say: "Sorry, I'm having trouble hearing you. Let me put you through to the shop.",
        transferTo: ctx.transferNumber ?? undefined,
        outcome: "TRANSFERRED",
      };
    }

    if (!turn.say) {
      turn.say = "Sorry, could you say that again?";
    }
    state.turns.push({ role: "assistant", text: turn.say });
    if (turn.outcome) state.outcome = turn.outcome;
    return { turn, state };
  }

  /**
   * Strip anything that only makes sense on a screen. The model is told not to
   * produce markdown, but this is the last line of defence: a text-to-speech
   * engine reads "asterisk asterisk" out loud, and the caller hears nonsense.
   */
  private speakable(text: string): string {
    return text
      .replace(/[*_`#]+/g, "")
      .replace(/^\s*[-•]\s*/gm, "")
      .replace(/\s*\n+\s*/g, " ")
      .replace(/\s{2,}/g, " ")
      .trim();
  }

  // ── System prompt ───────────────────────────────────────────────────────

  private systemPrompt(ctx: VoiceContext): string {
    const menu = ctx.items
      .map((it) => {
        const mods = it.modifierGroups
          .map((g) => {
            const opts = g.options
              .map((o) => `${o.name}${o.price ? ` +£${o.price.toFixed(2)}` : ""} [${o.id}]`)
              .join(", ");
            const rule = g.required
              ? `REQUIRED pick ${g.min}${g.max ? `-${g.max}` : "+"}`
              : `optional`;
            return `    - ${g.name} (${rule}): ${opts}`;
          })
          .join("\n");
        return `  ${it.name} — £${it.price.toFixed(2)} [${it.id}]${
          it.description ? ` — ${it.description}` : ""
        }${mods ? `\n${mods}` : ""}`;
      })
      .join("\n");

    return `You are answering the telephone for ${ctx.locationName}, a takeaway. You are speaking out loud to a customer on a phone call. You take orders, answer questions, and hand over to a human when you should.

HOW TO SPEAK
Everything you write is read aloud by a speech engine, so write it the way a person talks.
- Short sentences. No markdown, no bullet points, no emoji, no headings, no lists.
- Say prices as words: "four pounds fifty", not "£4.50".
- Ask ONE question at a time and wait. The caller cannot scroll back or re-read you.
- Never read the whole menu out. If asked what you do, name two or three popular things and ask what they fancy.
- Keep your turns to a sentence or two. A long speech on the phone is unbearable.

TAKING AN ORDER
- Add items as they say them with add_item. Use the exact item id from the menu below.
- If an item has a REQUIRED option group, ask for that choice before adding it — one group at a time, offering at most three options aloud.
- Never invent a dish, a price, or an option that is not on the menu below. If they ask for something you do not have, say so plainly and suggest the closest thing you do have.
- Ask whether it is collection or delivery early, because it changes the price and the time.
- For delivery, get the postcode first and run check_delivery_area before taking the rest of the address. Do not take a full address for an area the shop does not deliver to.

BEFORE YOU PLACE ANYTHING
Read the whole order back — every item, the total, and collection or delivery — and wait for them to confirm. This is not optional. A wrong order that reaches the kitchen is the worst thing you can do.

WHEN TO HAND OVER TO A HUMAN
Use transfer_to_staff immediately if: they ask for a person, they are upset or complaining, they are asking about an existing order you cannot find, they want something you cannot do, or you have misheard them twice in a row. Handing over is never a failure. Say "let me put you through" and do it.
If nobody can take the call, use take_message instead so the shop can ring them back.

THINGS TO GET RIGHT
- Confirm the caller's name before placing an order, and spell back anything unusual.
- If they go quiet, ask once if they are still there.
- If they say something you did not catch, ask them to repeat it — do not guess an order.
- Never promise a delivery time faster than the shop's own: about ${ctx.deliveryPrepMinutes} minutes for delivery, ${ctx.collectionPrepMinutes} for collection.

MENU
${menu || "(no items available — apologise and transfer)"}`;
  }

  // ── Tools ───────────────────────────────────────────────────────────────

  private toolDefs(ctx: VoiceContext): Anthropic.Tool[] {
    return [
      {
        name: "add_item",
        description:
          "Add one menu item to the order. Ask for any REQUIRED option group before calling this.",
        input_schema: {
          type: "object",
          properties: {
            itemId: { type: "string", description: "Exact item id from the menu" },
            quantity: { type: "integer", minimum: 1, default: 1 },
            modifierOptionIds: {
              type: "array",
              items: { type: "string" },
              description: "Chosen option ids, exactly as listed in the menu",
            },
            notes: { type: "string", description: "e.g. no onions" },
          },
          required: ["itemId"],
        },
      },
      {
        name: "remove_item",
        description: "Remove a line the caller changed their mind about.",
        input_schema: {
          type: "object",
          properties: { lineId: { type: "string" } },
          required: ["lineId"],
        },
      },
      {
        name: "set_fulfillment",
        description:
          "Set collection or delivery. For delivery, include the address once check_delivery_area has confirmed you deliver there.",
        input_schema: {
          type: "object",
          properties: {
            type: { type: "string", enum: ["DELIVERY", "PICKUP"] },
            line1: { type: "string" },
            city: { type: "string" },
            postcode: { type: "string" },
          },
          required: ["type"],
        },
      },
      {
        name: "check_delivery_area",
        description:
          "Check whether the shop delivers to a postcode, and what the fee is. Always call this before taking a full delivery address.",
        input_schema: {
          type: "object",
          properties: { postcode: { type: "string" } },
          required: ["postcode"],
        },
      },
      {
        name: "get_opening_hours",
        description: "The shop's opening hours, for 'what time do you close' questions.",
        input_schema: { type: "object", properties: {} },
      },
      {
        name: "get_order_status",
        description:
          "Look up this caller's most recent order — for 'where is my food' questions. Uses the number they are calling from.",
        input_schema: {
          type: "object",
          properties: {
            orderNumber: { type: "string", description: "Only if they read one out" },
          },
        },
      },
      {
        name: "place_order",
        description:
          "Place the order. ONLY after you have read the full order back and the caller has confirmed it.",
        input_schema: {
          type: "object",
          properties: {
            customerName: { type: "string" },
            paymentMethod: {
              type: "string",
              enum: ["CASH", "CARD"],
              description: "CASH = pay at the shop or on delivery. CARD = we text a payment link.",
            },
            notes: { type: "string", description: "Allergies, door instructions" },
          },
          required: ["customerName"],
        },
      },
      {
        name: "take_message",
        description:
          "Record a message for the shop to deal with later, when you cannot help and nobody can take the call.",
        input_schema: {
          type: "object",
          properties: {
            message: { type: "string" },
            callerName: { type: "string" },
          },
          required: ["message"],
        },
      },
      {
        name: "transfer_to_staff",
        description:
          "Hand the call to a human. Use freely — for complaints, anything you cannot do, or a second misunderstanding.",
        input_schema: {
          type: "object",
          properties: { reason: { type: "string" } },
          required: ["reason"],
        },
      },
      {
        name: "end_call",
        description: "Say goodbye and hang up, once the caller is done.",
        input_schema: {
          type: "object",
          properties: { reason: { type: "string" } },
        },
      },
    ];
  }

  private async runTool(
    name: string,
    input: any,
    ctx: VoiceContext,
    state: VoiceState,
    callerNumber?: string | null,
  ): Promise<{ result: string; turn?: Partial<VoiceTurn> }> {
    switch (name) {
      case "add_item":
        return { result: this.addItem(input, ctx, state) };
      case "remove_item": {
        const before = state.cart.items.length;
        state.cart.items = state.cart.items.filter((l) => l.lineId !== String(input?.lineId));
        return {
          result:
            state.cart.items.length < before
              ? `Removed. Order is now:\n${summarizeCart(state.cart)}`
              : "That line isn't on the order.",
        };
      }
      case "set_fulfillment": {
        const type = input?.type === "PICKUP" ? "PICKUP" : "DELIVERY";
        state.cart.fulfillmentType = type;
        state.cart.fulfillmentChosen = true;
        if (type === "DELIVERY" && input?.postcode) {
          state.cart.deliveryAddress = {
            line1: String(input.line1 ?? ""),
            city: String(input.city ?? ctx.address?.city ?? ""),
            postcode: String(input.postcode),
            country: "GB",
          };
        }
        return { result: `Set to ${type}.` };
      }
      case "check_delivery_area":
        return { result: this.checkArea(String(input?.postcode ?? ""), ctx) };
      case "get_opening_hours":
        return { result: this.openingHours(ctx) };
      case "get_order_status":
        return { result: await this.orderStatus(ctx, callerNumber, input?.orderNumber) };
      case "place_order":
        return this.placeOrder(input, ctx, state, callerNumber);
      case "take_message": {
        state.message = String(input?.message ?? "").slice(0, 1000);
        return {
          result: "Message saved for the shop.",
          turn: { outcome: "ENQUIRY" },
        };
      }
      case "transfer_to_staff":
        return {
          result: ctx.transferNumber
            ? "Transferring now."
            : "No transfer number configured — take a message instead.",
          turn: ctx.transferNumber
            ? { transferTo: ctx.transferNumber, outcome: "TRANSFERRED" }
            : undefined,
        };
      case "end_call":
        return { result: "Ending call.", turn: { endCall: true } };
      default:
        return { result: `Unknown tool ${name}` };
    }
  }

  private addItem(input: any, ctx: VoiceContext, state: VoiceState): string {
    const item = ctx.itemIndex.get(String(input?.itemId ?? ""));
    if (!item) return "That item isn't on the menu — tell the caller and suggest something similar.";

    const chosenIds: string[] = Array.isArray(input?.modifierOptionIds)
      ? input.modifierOptionIds.map(String)
      : [];

    // A required group that was never asked about is the classic way an order
    // reaches the kitchen wrong. Refuse and make the model ask.
    for (const g of item.modifierGroups) {
      if (!g.required) continue;
      const picked = g.options.filter((o) => chosenIds.includes(o.id));
      if (picked.length < Math.max(1, g.min)) {
        return `Before adding this you must ask which ${g.name} they want. Options: ${g.options
          .map((o) => o.name)
          .join(", ")}.`;
      }
    }

    const modifiers = chosenIds
      .map((id) => ctx.optionIndex.get(id))
      .filter(Boolean)
      .map((m: any) => ({ optionId: m.option.id, name: m.option.name, price: m.option.price }));

    const line = {
      lineId: Math.random().toString(36).slice(2, 9),
      itemId: item.id,
      name: item.name,
      quantity: Math.max(1, Math.round(Number(input?.quantity) || 1)),
      unitBasePrice: item.price,
      modifiers,
      notes: input?.notes ? String(input.notes) : undefined,
    };
    state.cart.items.push(line);
    return `Added ${line.quantity} × ${item.name} at £${lineUnitPrice(line).toFixed(
      2,
    )} each.\nOrder so far:\n${summarizeCart(state.cart)}`;
  }

  private checkArea(postcode: string, ctx: VoiceContext): string {
    const pc = postcode.toUpperCase().replace(/\s+/g, "");
    if (!pc) return "Ask them for the postcode.";
    let best: { prefix: string; fee: number; minOrder: number | null } | null = null;
    for (const z of ctx.deliveryZones) {
      const zp = z.postcodePrefix.toUpperCase().replace(/\s+/g, "");
      if (pc.startsWith(zp) && (!best || zp.length > best.prefix.length)) {
        best = { prefix: zp, fee: z.fee, minOrderValue: z.minOrderValue } as any;
      }
    }
    if (!best) {
      return `The shop does NOT deliver to ${postcode}. Tell them, and offer collection instead.`;
    }
    const min = (best as any).minOrderValue;
    return `Delivers to ${postcode}. Fee £${best.fee.toFixed(2)}${
      min ? `, minimum order £${Number(min).toFixed(2)}` : ""
    }.`;
  }

  private openingHours(ctx: VoiceContext): string {
    const oh = ctx.openingHours as any;
    if (!oh || typeof oh !== "object") {
      return "Opening hours aren't recorded — offer to take a message or transfer.";
    }
    const days = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"];
    const parts = days
      .map((d) => {
        const v = oh[d];
        if (!v || v.closed) return `${d}: closed`;
        return `${d}: ${v.open ?? "?"}–${v.close ?? "?"}`;
      })
      .join("; ");
    return `Opening hours — ${parts}. Answer only the day they asked about.`;
  }

  private async orderStatus(
    ctx: VoiceContext,
    callerNumber?: string | null,
    orderNumber?: string,
  ): Promise<string> {
    const where: any = { locationId: ctx.locationId };
    if (orderNumber) {
      where.orderNumber = String(orderNumber).replace(/\D/g, "");
    } else {
      const digits = normaliseNumber(callerNumber);
      if (!digits) return "No caller number — ask them for their order number.";
      // Match on the last 9 digits so 07700…/+4477… both hit.
      where.customerPhone = { contains: digits.slice(-9) };
    }
    const order = await this.db().order.findFirst({
      where,
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        orderNumber: true,
        status: true,
        fulfillmentType: true,
        total: true,
        createdAt: true,
        estimatedReadyTime: true,
      },
    });
    if (!order) {
      return "No recent order found for this caller. Offer to transfer them to the shop.";
    }
    const mins = order.estimatedReadyTime
      ? Math.max(0, Math.round((new Date(order.estimatedReadyTime).getTime() - Date.now()) / 60000))
      : null;
    return `Order ${order.orderNumber}, status ${order.status}, ${order.fulfillmentType}, total £${Number(
      order.total,
    ).toFixed(2)}${mins != null ? `, about ${mins} minutes away` : ""}.`;
  }

  private async placeOrder(
    input: any,
    ctx: VoiceContext,
    state: VoiceState,
    callerNumber?: string | null,
  ): Promise<{ result: string; turn?: Partial<VoiceTurn> }> {
    if (state.orderId) {
      return { result: `Already placed — order is in. Do not place it again.` };
    }
    if (state.cart.items.length === 0) {
      return { result: "The order is empty — nothing to place." };
    }
    const isDelivery = state.cart.fulfillmentType === "DELIVERY";
    if (isDelivery && !state.cart.deliveryAddress?.postcode) {
      return { result: "You need a delivery address first. Ask for it." };
    }

    const items = state.cart.items.map((l) => ({
      menuItemId: l.itemId,
      name: l.name,
      quantity: l.quantity,
      unitPrice: round2(lineUnitPrice(l)),
      totalPrice: round2(lineTotal(l)),
      ...(l.modifiers.length
        ? { modifiers: l.modifiers.map((m) => ({ name: m.name, price: m.price })) }
        : {}),
      ...(l.notes ? { notes: l.notes } : {}),
    }));
    const subtotal = cartSubtotal(state.cart);
    const deliveryFee = isDelivery
      ? this.feeForPostcode(state.cart.deliveryAddress!.postcode, ctx)
      : 0;
    const isCard = String(input?.paymentMethod ?? "").toUpperCase() === "CARD";

    try {
      const order: any = await this.orders.create(
        {
          locationId: ctx.locationId,
          ...(ctx.brandId ? { brandId: ctx.brandId } : {}),
          orderSource: "PHONE",
          fulfillmentType: isDelivery ? "DELIVERY" : "PICKUP",
          customerInfo: {
            name: String(input?.customerName ?? "Phone order"),
            phone: callerNumber ?? undefined,
          },
          ...(isDelivery ? { deliveryAddress: state.cart.deliveryAddress } : {}),
          items,
          subtotal,
          ...(deliveryFee > 0 ? { deliveryFee } : {}),
          total: round2(subtotal + deliveryFee),
          specialInstructions: [
            "TAKEN BY AI PHONE LINE",
            input?.notes ? String(input.notes) : "",
          ]
            .filter(Boolean)
            .join(" · "),
          paymentMethod: isCard ? "CARD" : "CASH",
          paymentStatus: "PENDING",
          idempotencyKey: `voice-${state.turns.length}-${ctx.locationId}-${normaliseNumber(
            callerNumber,
          )}-${Math.round(subtotal * 100)}`,
        } as any,
        ctx.tenantId,
      );
      state.orderId = order.id;

      let extra = "";
      if (isCard && callerNumber) {
        extra = await this.textPaymentLink(ctx, order, callerNumber);
      }
      const mins = isDelivery ? ctx.deliveryPrepMinutes : ctx.collectionPrepMinutes;
      return {
        result: `Order ${order.orderNumber} placed. Total £${round2(subtotal + deliveryFee).toFixed(
          2,
        )}. Tell them roughly ${mins} minutes.${extra}`,
        turn: { orderId: order.id, outcome: "ORDER" },
      };
    } catch (e: any) {
      this.logger.error(`Voice order create failed: ${e?.message ?? e}`);
      return {
        result:
          "The order could not be saved. Apologise and transfer them to the shop — do not tell them it is confirmed.",
        turn: { transferTo: ctx.transferNumber ?? undefined, outcome: "TRANSFERRED" },
      };
    }
  }

  private feeForPostcode(postcode: string, ctx: VoiceContext): number {
    const pc = postcode.toUpperCase().replace(/\s+/g, "");
    let best: { prefix: string; fee: number } | null = null;
    for (const z of ctx.deliveryZones) {
      const zp = z.postcodePrefix.toUpperCase().replace(/\s+/g, "");
      if (pc.startsWith(zp) && (!best || zp.length > best.prefix.length)) {
        best = { prefix: zp, fee: z.fee };
      }
    }
    return best?.fee ?? 0;
  }

  /** Card orders get a Stripe link by text — nobody should read a card number
   *  aloud to a machine, and we never want it in a transcript. */
  private async textPaymentLink(
    ctx: VoiceContext,
    order: any,
    to: string,
  ): Promise<string> {
    try {
      const origin = (
        this.config.get<string>("WEB_URL") ?? "https://www.orderhubsolutions.com"
      ).replace(/\/+$/, "");
      const { url } = await this.payments.createCheckoutSession({
        tenantId: ctx.tenantId,
        orderId: order.id,
        successUrl: `${origin}/p/paid`,
        cancelUrl: `${origin}/p/cancelled`,
      });
      await this.sms.send({
        tenantId: ctx.tenantId,
        to,
        body: `${ctx.locationName}: pay for order ${order.orderNumber} here ${url}`,
        purpose: "PAYMENT_LINK",
        locationId: ctx.locationId,
        brandId: ctx.brandId ?? null,
        orderId: order.id,
      });
      return " A payment link has been texted to them.";
    } catch (e: any) {
      this.logger.warn(`Voice payment link failed for order ${order.id}: ${e?.message}`);
      // The order exists and the kitchen has it. Falling back to paying at the
      // shop is far better than telling the caller their order failed.
      return " The payment text failed — tell them they can pay at the shop.";
    }
  }
}
