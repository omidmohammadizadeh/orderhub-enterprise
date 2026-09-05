import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import Anthropic from "@anthropic-ai/sdk";
import {
  resolveZone,
  zoneMode,
  areaZoneNames,
  postcodeRequiredFor,
  currencyName,
} from "@orderhub/shared";
import { money } from "../whatsapp/whatsapp-cart";
import { PrismaService } from "../../infrastructure/database/prisma.service";
import { OrdersService } from "../orders/orders.service";
import { SmsService } from "../sms/sms.service";
import { PaymentsService } from "../payments/payments.service";
import { AddressLookupService } from "../address-lookup/address-lookup.service";
import type { VoiceContext } from "./voice-context.service";
import { normaliseNumber } from "./voice-context.service";
import {
  addressLineFrom,
  findPostcodeIn,
  houseNumberFrom,
  resolveHeardPostcode,
  spokenDigits,
  streetOf,
  type VoiceStage,
} from "./voice-flow";
import {
  isConfident,
  matchMenuItems,
  splitQuantity,
} from "./voice-menu-match";
import { isCurrentlyOpen } from "../../common/opening-hours.util";
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

/** How long a caller may be left waiting on an address provider. */
const LOOKUP_TIMEOUT_MS = Number(process.env.VOICE_LOOKUP_TIMEOUT_MS) || 3500;
// Placing an order is now a chain of gated tool calls — read the order back,
// confirm the address, then place — so a turn that finishes an order needs
// more hops than one that just adds an item. Six was enough for the old
// free-for-all and would silently truncate the confirm-then-place sequence.
const MAX_TOOL_ITERATIONS = 8;

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
  /** The text was already streamed to the caller sentence by sentence, so the
   *  transport must not speak it a second time. */
  streamed?: boolean;
}

export interface VoiceState {
  turns: Array<{ role: "user" | "assistant"; text: string }>;
  cart: WaCart;
  /** Set once placed so we can't place twice on a re-ask. */
  orderId?: string;
  outcome?: string;
  message?: string;
  /** Where the call is in the fixed spine — see voice-flow.ts. */
  stage: VoiceStage;
  /**
   * The delivery address has been read back to the caller and they said yes.
   * A separate flag from "we have an address" on purpose: the whole failure
   * this guards against is an address we heard wrong, which looks exactly like
   * an address we heard right until the driver is lost.
   */
  addressConfirmed?: boolean;
  /**
   * The full order has been read back and confirmed aloud. place_order refuses
   * without it. The system prompt has always asked for this; a prompt is a
   * request, and the thing that gets the AI switched off for good deserves a
   * lock.
   */
  orderConfirmed?: boolean;
  /** Their last delivery address, from caller ID. Lets us ask "still at
   *  Follingsby Drive?" instead of taking the whole thing again. */
  savedAddress?: {
    line1: string;
    city: string;
    postcode: string;
    country?: string;
  };
  /** Name from caller ID, so we greet them and don't ask for it twice. */
  knownName?: string;
  /** The VoiceCall row id. Only used to key order idempotency to the call. */
  callId?: string;
  /**
   * We have just asked a question whose only real answer is yes or no, and we
   * know which question. That makes the next turn answerable in code, and
   * these are the two slowest and most common turns in the whole call.
   */
  awaiting?:
    | "ADDRESS_CONFIRM"
    | "ORDER_CONFIRM"
    | "FULFILLMENT"
    | "PAYMENT"
    | "NAME"
    /** Asked for the postcode, nothing else yet. */
    | "ADDR_POSTCODE"
    /** Read the street back off the postcode; waiting for yes or no. */
    | "ADDR_STREET"
    /** Street agreed; waiting for the house number or name. */
    | "ADDR_HOUSE";
  /** The address being built up, one question at a time. */
  addr?: { postcode?: string; street?: string; city?: string };
  /** How they said they'd pay, held while we ask for a name. */
  pendingPayment?: "CASH" | "CARD";
  /**
   * We are ADDING to an order that already exists, not building a new one.
   *
   * When set, the cart holds that order's existing lines plus whatever the
   * caller is adding, and the turn ends in an edit rather than a placement.
   */
  amendOrderId?: string;
  /** What the board calls the order being amended, for reading back. */
  amendReference?: string;
  /**
   * How many turns running we have failed to understand.
   *
   * Kept so that "I didn't catch that" can escalate into a different question
   * rather than the same one, and so that giving up is a decision made against
   * a number rather than a feeling.
   */
  confusion?: number;
  /** The caller asked for a human, in words. Distinct from us deciding they
   *  should have one, which is not the same thing at all. */
  askedForHuman?: boolean;
}

export function emptyState(): VoiceState {
  return { turns: [], cart: emptyCart(), stage: "MENU" };
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
    // Calls that were already in flight when this deployed have no stage.
    // They resume in ORDER rather than being sent back to a menu they have
    // already answered.
    stage: (["MENU", "ORDER", "STATUS", "DONE"] as const).includes(r.stage)
      ? r.stage
      : "ORDER",
    addressConfirmed: r.addressConfirmed === true,
    orderConfirmed: r.orderConfirmed === true,
    savedAddress:
      r.savedAddress && typeof r.savedAddress === "object"
        ? {
            line1: String(r.savedAddress.line1 ?? ""),
            city: String(r.savedAddress.city ?? ""),
            postcode: String(r.savedAddress.postcode ?? ""),
            country: r.savedAddress.country
              ? String(r.savedAddress.country)
              : undefined,
          }
        : undefined,
    knownName: r.knownName ? String(r.knownName) : undefined,
    pendingPayment:
      r.pendingPayment === "CASH" || r.pendingPayment === "CARD"
        ? r.pendingPayment
        : undefined,
    amendOrderId: r.amendOrderId ? String(r.amendOrderId) : undefined,
    amendReference: r.amendReference ? String(r.amendReference) : undefined,
    confusion: Number.isFinite(Number(r.confusion)) ? Number(r.confusion) : 0,
    askedForHuman: r.askedForHuman === true,
    callId: r.callId ? String(r.callId) : undefined,
    addr:
      r.addr && typeof r.addr === "object"
        ? {
            postcode: r.addr.postcode ? String(r.addr.postcode) : undefined,
            street: r.addr.street ? String(r.addr.street) : undefined,
            city: r.addr.city ? String(r.addr.city) : undefined,
          }
        : undefined,
    awaiting: (
      [
        "ADDRESS_CONFIRM",
        "ORDER_CONFIRM",
        "FULFILLMENT",
        "PAYMENT",
        "NAME",
        "ADDR_POSTCODE",
        "ADDR_STREET",
        "ADDR_HOUSE",
      ] as const
    ).includes(r.awaiting)
      ? r.awaiting
      : undefined,
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
    private readonly addresses: AddressLookupService,
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

  /**
   * The greeting and the menu, in one breath.
   *
   * Deliberately code, not model output: the first thing a caller hears has to
   * be instant and identical every time. A model-generated greeting costs a
   * second of dead air on pickup, and a second of silence after "hello" is how
   * a caller decides the line is broken.
   *
   * The menu is spoken as options to PRESS, because that is what a caller
   * expects and what works on a bad line — but interpretMenuChoice also
   * accepts them spoken, and a caller who just starts ordering over the top of
   * this never hears the rest of it. See voice-flow.ts.
   */
  greeting(ctx: VoiceContext, knownName?: string | null): string {
    const who = knownName ? `Hello ${knownName}, welcome back to` : "Hello and welcome to";
    return `${who} ${ctx.locationName}. ${this.menuOptions()}`;
  }

  /**
   * The options, on their own, so option 5 can say them again without the
   * greeting attached — nobody wants to be welcomed to the shop twice.
   *
   * Five options is a lot to listen to, and the reason that is tolerable here
   * is that none of it has to be heard: the menu is interruptible, a keypress
   * lands at any point, and a caller who just starts talking is taken straight
   * into their order.
   */
  menuOptions(): string {
    return [
      "To place an order, press 1.",
      "For an update on an order, press 2.",
      "To change an order you've already placed, press 3.",
      "To report a problem with an order, press 4.",
      "To hear these again, press 5.",
    ].join(" ");
  }

  /** Option 3. */
  amendOpener(): string {
    return "No problem. Can I have your order number?";
  }

  /**
   * Option 4. Straight to a person, with no attempt to handle it.
   *
   * A complaint is the one thing on this line that must never be absorbed by
   * a machine. Someone whose food arrived cold does not want a menu, and any
   * apology from us is worth nothing because we cannot put it right.
   */
  complaintOpener(): string {
    return "I'm sorry to hear that. Let me put you straight through to the shop.";
  }

  /** What the caller hears when the order they want to change is not ours to
   *  change — the platform owns it, and so does the correction. */
  amendElsewhere(via: string): string {
    return `That order came through ${via}, so I can't change it from here. Let me put you through to the shop.`;
  }

  /** What the caller hears the moment they choose to order. Fixed, because
   *  "collection or delivery" is the question that changes the price, the
   *  time and half the conversation that follows it — it should never be the
   *  model's decision whether to ask it. */
  orderOpener(state: VoiceState): string {
    return state.knownName
      ? `Lovely. Is that collection or delivery?`
      : `OK, new order. Is that collection or delivery?`;
  }

  /** What the caller hears when they want to chase an order. */
  statusOpener(): string {
    return `No problem. What's your order number?`;
  }

  /**
   * The caller agreed to the address we read back. Confirms it, prices it from
   * the shop's own zones, and asks the next question — no model involved.
   */
  async confirmAddressAloud(ctx: VoiceContext, state: VoiceState): Promise<string> {
    await this.runTool("confirm_delivery_address", {}, ctx, state, null);
    if (!state.addressConfirmed) {
      // Outside the delivery area. Say so — but never leave them with nowhere
      // to go, because "we don't deliver there" with no follow-up is where a
      // caller hangs up and orders from someone else.
      return "I'm sorry, we don't deliver that far. I can do it for collection instead, or if there's another address you'd like it sent to, just say.";
    }
    const fee = this.feeForAddress(state.cart.deliveryAddress, ctx);
    const feeLine = fee > 0 ? ` Delivery is ${money(fee, ctx.currency)}.` : "";
    return `Great.${feeLine} What would you like to order?`;
  }

  /** The caller agreed to the order we read back. */
  confirmOrderAloud(state: VoiceState): string {
    state.orderConfirmed = true;
    return "How would you like to pay — cash, or card?";
  }

  /**
   * "Delivery" or "collection", answered without a model.
   *
   * The very first thing a caller says after pressing 1, with exactly two
   * possible answers. It used to cost a prompt carrying the whole menu, a tool
   * call to record the choice, and a second round trip to ask the next
   * question — two to four seconds to understand one word.
   */
  fulfillmentAloud(
    ctx: VoiceContext,
    state: VoiceState,
    choice: "DELIVERY" | "PICKUP",
  ): { say: string; next?: VoiceState["awaiting"] } {
    state.cart.fulfillmentType = choice;
    state.cart.fulfillmentChosen = true;

    if (choice === "PICKUP") {
      state.cart.deliveryAddress = undefined;
      state.addressConfirmed = false;
      return { say: "Lovely, collection it is. What would you like to order?" };
    }

    // A regular gets one yes instead of reciting where they live.
    const saved = state.savedAddress;
    if (saved?.line1) {
      return {
        say: `Are you still at ${saved.line1}?`,
        next: "ADDRESS_CONFIRM",
      };
    }
    // Postcode first, and on its own.
    //
    // Asking for a whole address in one breath asks the transcriber to get a
    // street name right, and it has never heard of Follingsby Drive. A
    // postcode is six or seven characters from a fixed alphabet, we can look
    // the street up from it, and then the caller only has to say a house
    // number. Every part of that is something speech recognition is good at.
    return postcodeRequiredFor(ctx.country)
      ? { say: "No problem. What's your postcode?", next: "ADDR_POSTCODE" }
      : { say: "No problem. Can I take your address, and the area you're in?" };
  }

  /**
   * "Cash" or "card", and then the order itself.
   *
   * The last turn of the call and the slowest one to sit through, because the
   * model had to decide to place, place, and then say what happened. Both
   * locks still apply — placeOrder refuses without them, whoever calls it.
   */
  async payAndPlaceAloud(
    ctx: VoiceContext,
    state: VoiceState,
    method: "CASH" | "CARD",
    callerNumber?: string | null,
  ): Promise<{ say: string; turn?: Partial<VoiceTurn>; next?: VoiceState["awaiting"] }> {
    // We need a name on the ticket, and asking for it is one short turn — far
    // better than the kitchen getting "Phone order".
    if (!state.knownName) {
      state.pendingPayment = method;
      return { say: "And can I take your name?", next: "NAME" };
    }
    return this.placeAloud(ctx, state, method, state.knownName, callerNumber);
  }

  /** The caller just gave their name at the end of the order. */
  async namedAndPlaceAloud(
    ctx: VoiceContext,
    state: VoiceState,
    name: string,
    callerNumber?: string | null,
  ): Promise<{ say: string; turn?: Partial<VoiceTurn> }> {
    const method = state.pendingPayment === "CARD" ? "CARD" : "CASH";
    return this.placeAloud(ctx, state, method, name, callerNumber);
  }

  private async placeAloud(
    ctx: VoiceContext,
    state: VoiceState,
    method: "CASH" | "CARD",
    customerName: string,
    callerNumber?: string | null,
  ): Promise<{ say: string; turn?: Partial<VoiceTurn> }> {
    const out = await this.placeOrder(
      { customerName, paymentMethod: method },
      ctx,
      state,
      callerNumber,
    );
    // A refusal here is a gate doing its job — the order was never read back,
    // or the address never confirmed. Hand it to the model rather than
    // inventing a line for a case that should not happen.
    if (!state.orderId) {
      return { say: "", turn: out.turn };
    }

    const mins =
      state.cart.fulfillmentType === "DELIVERY"
        ? ctx.deliveryPrepMinutes
        : ctx.collectionPrepMinutes;
    const where =
      state.cart.fulfillmentType === "DELIVERY" ? "with you" : "ready";
    const card =
      method === "CARD"
        ? " I've sent you a payment link — you can pay on your phone."
        : "";
    return {
      say: `That's all booked in. It'll be about ${mins} minutes ${where}.${card} Thanks for calling, goodbye.`,
      turn: { ...out.turn, endCall: true },
    };
  }

  /**
   * The postcode, looked up, with the street read back for a yes or no.
   *
   * Nothing here reaches the model. The whole point of asking one short
   * question at a time is that each answer is something we can check
   * ourselves — and checking it against a real address database is the
   * difference between "is that Follingsby Drive?" and hoping.
   */
  async postcodeAloud(
    ctx: VoiceContext,
    state: VoiceState,
    said: string,
    lookup: (postcode: string) => Promise<Array<{ line1?: string; city?: string }>>,
  ): Promise<{ say: string; next?: VoiceState["awaiting"] }> {
    // Asked for a postcode, plenty of people give the whole address. The
    // postcode is the end of it, so that is where this looks — rather than
    // demanding they say it again on its own, which is the sort of thing that
    // makes people hang up.
    const postcode = findPostcodeIn(
      said,
      ctx.deliveryZones.map((z) => z.postcodePrefix),
    );

    if (!postcode) {
      const misses = (state.confusion ?? 0) + 1;
      state.confusion = misses;
      return misses < 3
        ? {
            say: "Sorry, that didn't sound like a postcode. Could you say it one character at a time?",
            next: "ADDR_POSTCODE",
          }
        : {
            say: "Let's do it the other way round — what's the street and house number?",
          };
    }
    state.confusion = 0;

    // Hard timeout. A live call sat for THIRTEEN SECONDS on this lookup — the
    // provider chain has no deadline of its own, and a caller does not know
    // the difference between a slow API and a line that has died. Two seconds
    // is already longer than anyone wants to wait; past that we get on with
    // it and ask for the street instead.
    let found: Array<{ line1?: string; city?: string }> = [];
    try {
      found = await Promise.race([
        lookup(postcode),
        new Promise<Array<{ line1?: string; city?: string }>>((resolve) =>
          setTimeout(() => resolve([]), LOOKUP_TIMEOUT_MS),
        ),
      ]);
    } catch {
      // A lookup outage must not stop somebody ordering dinner.
      found = [];
    }

    state.addr = { postcode };

    // Every address on a postcode shares a street, so the first REAL one names
    // it. The lookup's last resort returns the town with an empty line1, and
    // reading position zero blindly treated that as "no street came back" even
    // when a street was sitting behind it.
    const withStreet = found.find((f) => streetOf(f.line1));
    const street = streetOf(withStreet?.line1) ?? null;
    const city = withStreet?.city ?? found[0]?.city ?? ctx.address?.city ?? undefined;
    if (!street) {
      return {
        say: `Thanks. And what's the street?`,
        next: "ADDR_HOUSE",
      };
    }

    state.addr.street = street;
    state.addr.city = city;
    return {
      say: `Thanks. That's ${street}${city ? `, ${city}` : ""} — is that right?`,
      next: "ADDR_STREET",
    };
  }

  /**
   * The same postcode lookup the scripted flow uses, exposed to the model.
   *
   * The model only drives an address when the scripted path has already been
   * knocked off course, and that is exactly when it must not fall back to
   * asking for the whole thing in one breath. Giving it the lookup means the
   * worst case still follows the same shape as the best case.
   */
  private async lookupPostcode(
    said: string,
    ctx: VoiceContext,
    state: VoiceState,
  ): Promise<string> {
    const postcode = findPostcodeIn(
      said,
      ctx.deliveryZones.map((z) => z.postcodePrefix),
    );
    if (!postcode) {
      return "That didn't contain a postcode. Ask them for the postcode on its own, one character at a time.";
    }
    state.addr = { ...(state.addr ?? {}), postcode };

    let found: Array<{ line1?: string; city?: string }> = [];
    try {
      found = await Promise.race([
        this.addresses
          .searchByPostcode(postcode)
          .then((r: any) => r.suggestions.map((sg: any) => ({ line1: sg.line1, city: sg.city }))),
        new Promise<Array<{ line1?: string; city?: string }>>((resolve) =>
          setTimeout(() => resolve([]), LOOKUP_TIMEOUT_MS),
        ),
      ]);
    } catch {
      found = [];
    }

    const withStreet = found.find((f) => streetOf(f.line1));
    const street = streetOf(withStreet?.line1) ?? null;
    const city = withStreet?.city ?? found[0]?.city ?? ctx.address?.city ?? undefined;
    if (!street) {
      return `Postcode ${postcode} is noted, but no street came back for it. Ask them for the street name and house number together — do NOT ask for the postcode again.`;
    }
    state.addr.street = street;
    state.addr.city = city;
    return `Postcode ${postcode} is ${street}${city ? `, ${city}` : ""}. Say "That's ${street}${city ? `, ${city}` : ""} — is that right?" and wait. If they say yes, ask only for the house number or name.`;
  }

  /** They confirmed the street. Only the number is left. */
  streetAgreedAloud(): { say: string; next: VoiceState["awaiting"] } {
    return { say: "Great. And the house number or name?", next: "ADDR_HOUSE" };
  }

  /**
   * The looked-up street was wrong.
   *
   * Asking for the postcode again would be asking for the thing they already
   * got right. They know their own street; the database evidently does not, so
   * this hands the question back to them — street and number together, because
   * that is how anyone says it.
   */
  streetRejectedAloud(state: VoiceState): { say: string; next: VoiceState["awaiting"] } {
    if (state.addr) state.addr.street = undefined;
    return {
      say: "Sorry about that. What's the street name and house number?",
      next: "ADDR_HOUSE",
    };
  }

  /**
   * House number in, whole address back out for a final yes.
   *
   * The read-back is the whole thing, not the bit they just said, because
   * that is the only version of it the caller has heard end to end.
   */
  houseNumberAloud(
    ctx: VoiceContext,
    state: VoiceState,
    said: string,
  ): { say: string; next: VoiceState["awaiting"] } {
    const street = state.addr?.street;
    // With a street already agreed, all that is wanted is the number. Without
    // one — the lookup found nothing, or the caller said it was wrong — they
    // are giving the whole line, and "11 Fellside Road" has to survive intact.
    const line1 = street
      ? (() => {
          const house = houseNumberFrom(said);
          return house ? `${house} ${street}` : null;
        })()
      : addressLineFrom(said) ?? houseNumberFrom(said);

    if (!line1) {
      return {
        say: street
          ? "Sorry, what was the house number or name?"
          : "Sorry, what's the street name and house number?",
        next: "ADDR_HOUSE",
      };
    }

    state.cart.fulfillmentType = "DELIVERY";
    state.cart.fulfillmentChosen = true;
    state.cart.deliveryAddress = {
      line1,
      city: state.addr?.city ?? ctx.address?.city ?? "",
      postcode: state.addr?.postcode,
      country: ctx.country,
    };
    state.addressConfirmed = false;

    return {
      say: `So that's ${this.spokenAddress(state.cart.deliveryAddress)}. Is that correct?`,
      next: "ADDRESS_CONFIRM",
    };
  }

  /** They said no to a read-back. */
  rejectedReadBack(what: "ADDRESS_CONFIRM" | "ORDER_CONFIRM"): string {
    return what === "ADDRESS_CONFIRM"
      ? "No problem. What's your postcode?"
      : "No problem. What would you like to change?";
  }

  /** When we genuinely could not make out a menu choice twice running. Still
   *  never a dead end — it falls into taking an order. */
  menuFallback(): string {
    return `Sorry, I didn't catch that. I'll take an order — is that collection or delivery?`;
  }

  // ── The turn ────────────────────────────────────────────────────────────

  async respond(args: {
    ctx: VoiceContext;
    state: VoiceState;
    userText: string;
    callerNumber?: string | null;
    /**
     * Speak this now, with more to follow.
     *
     * Given by the relay transport, absent on the webhook one. When present,
     * the caller hears the first sentence while the model is still writing the
     * second — which is the difference between a line that answers in half a
     * second and one that answers in four.
     */
    onPartial?: (chunk: string) => void;
  }): Promise<{ turn: VoiceTurn; state: VoiceState }> {
    const { ctx } = args;
    const state = args.state;
    state.awaiting = undefined;
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
          text: this.systemPrompt(ctx, state),
          // The menu is re-sent on every turn of every call and is identical
          // across them. Caching it is the single biggest lever on our cost
          // per call — without it the Claude bill roughly triples.
          cache_control: { type: "ephemeral" },
        },
        { type: "text", text: `=== ORDER SO FAR ===\n${summarizeCart(state.cart, ctx.currency)}` },
      ];

      const tools = this.toolDefs(ctx);
      let spoken = "";

      // Did the caller already hear this, sentence by sentence, as it was
      // written? Only true on the relay transport, and only for text the model
      // itself produced.
      let streamedOut = false;
      let directUsed = false;
      for (let i = 0; i < MAX_TOOL_ITERATIONS; i++) {
        const params = {
          model: this.model,
          // A spoken turn is one or two sentences. The ceiling was 700, and
          // generation time scales with what the model actually writes — on a
          // phone call that ceiling is latency the caller sits through, not
          // headroom.
          max_tokens: 300,
          system,
          tools,
          messages,
        };

        const response = args.onPartial
          ? await this.streamTurn(params, args.onPartial, () => {
              streamedOut = true;
            })
          : await this.anthropic.messages.create(params);

        const text = response.content
          .filter((b): b is Anthropic.TextBlock => b.type === "text")
          .map((b) => b.text)
          .join(" ")
          .trim();
        // Accumulated, not replaced. A turn that says "let me just add that",
        // calls a tool, then says "done, anything else?" spoke BOTH out loud —
        // recording only the second leaves the transcript disagreeing with
        // what the caller actually heard.
        if (text) spoken = spoken ? `${spoken} ${text}` : text;

        const toolUses = response.content.filter(
          (b): b is Anthropic.ToolUseBlock => b.type === "tool_use",
        );
        if (response.stop_reason !== "tool_use" || toolUses.length === 0) break;

        messages.push({ role: "assistant", content: response.content });
        const results: Anthropic.ToolResultBlockParam[] = [];
        let direct: string | undefined;
        for (const tu of toolUses) {
          const out = await this.runTool(tu.name, tu.input as any, ctx, state, args.callerNumber);
          if (out.turn) turn = { ...turn, ...out.turn };
          if (out.sayNow) direct = out.sayNow;
          results.push({ type: "tool_result", tool_use_id: tu.id, content: out.result });
        }

        // Some tools compute the exact words to say — the address read-back,
        // the order read-back. Feeding those to the model so it can repeat
        // them costs a SECOND round trip, which on a real call was about two
        // and a half seconds of the caller listening to nothing. Saying them
        // straight out is both faster and safer: the read-back is now
        // guaranteed verbatim rather than paraphrased by a model that might
        // round a price or drop a line.
        if (direct) {
          // Ours, not the model's, so it has not been streamed even if a
          // preamble before it was. The transport still has to say it.
          spoken = direct;
          directUsed = true;
          break;
        }
        messages.push({ role: "user", content: results });
      }

      turn.say = this.speakable(spoken || turn.say);
      turn.streamed = streamedOut && !directUsed;
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
   * One model call, spoken as it is written.
   *
   * Text is forwarded a sentence at a time rather than a token at a time:
   * a speech engine handed "Great," then "that's" then "£12.50" reads them as
   * three separate utterances with a gap between each, which sounds worse than
   * waiting. A sentence is the smallest unit that still sounds like speech.
   *
   * Text the model writes BEFORE deciding to call a tool is forwarded too —
   * that is the natural "let me just check that for you" which covers the
   * lookup, and is exactly the moment a caller would otherwise hear silence.
   */
  private async streamTurn(
    params: Anthropic.MessageCreateParamsNonStreaming,
    onPartial: (chunk: string) => void,
    markStreamed: () => void,
  ): Promise<Anthropic.Message> {
    const stream = this.anthropic!.messages.stream(params);

    let buffer = "";
    let inText = false;
    stream.on("contentBlock", () => {
      // Flush whatever is left of a text block when it ends.
      if (inText && buffer.trim()) {
        onPartial(this.speakable(buffer));
        markStreamed();
        buffer = "";
      }
      inText = false;
    });
    stream.on("streamEvent", (event) => {
      if (event.type === "content_block_start") {
        inText = event.content_block.type === "text";
        return;
      }
      if (
        !inText ||
        event.type !== "content_block_delta" ||
        event.delta.type !== "text_delta"
      ) {
        return;
      }
      buffer += event.delta.text;
      // Emit on sentence boundaries only.
      const boundary = buffer.search(/[.!?](\s|$)/);
      if (boundary === -1) return;
      const sentence = buffer.slice(0, boundary + 1);
      buffer = buffer.slice(boundary + 1);
      const say = this.speakable(sentence);
      if (say) {
        onPartial(say);
        markStreamed();
      }
    });

    const message = await stream.finalMessage();
    if (buffer.trim()) {
      const say = this.speakable(buffer);
      if (say) {
        onPartial(say);
        markStreamed();
      }
    }
    return message;
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

  private systemPrompt(ctx: VoiceContext, state?: VoiceState): string {
    const menu = ctx.items
      .map((it) => {
        const mods = it.modifierGroups
          .map((g) => {
            const opts = g.options
              .map((o) => `${o.name}${o.price ? ` +${money(o.price, ctx.currency)}` : ""} [${o.id}]`)
              .join(", ");
            const rule = g.required
              ? `REQUIRED pick ${g.min}${g.max ? `-${g.max}` : "+"}`
              : `optional`;
            return `    - ${g.name} (${rule}): ${opts}`;
          })
          .join("\n");
        return `  ${it.name} — ${money(it.price, ctx.currency)} [${it.id}]${
          it.description ? ` — ${it.description}` : ""
        }${mods ? `\n${mods}` : ""}`;
      })
      .join("\n");

    // What locates a caller depends on the shop. Asking a Dubai caller for a
    // postcode gets you silence: there isn't one. Where the shop prices by
    // area, the areas are named here so the model asks for one of THEM rather
    // than inventing a plausible neighbourhood.
    const areas = areaZoneNames(ctx.deliveryZones as any);
    const deliveryGuidance = areas.length
      ? `- This shop delivers by AREA, not postcode. The areas are: ${areas.join(", ")}. Ask which one they are in, run check_delivery_area with it, and pass it to set_fulfillment as \`area\`. Never accept an area that is not on that list — say plainly that the shop does not deliver there and offer collection.`
      : postcodeRequiredFor(ctx.country)
        ? "- For delivery, get the postcode first and run check_delivery_area before taking the rest of the address. Do not take a full address for an area the shop does not deliver to."
        : "- Addresses here do NOT have postcodes. Never ask for one — take the building or street and the city.";

    // Caller ID turns the worst part of a phone order — reciting an address to
    // a machine — into one yes. Only offered, never assumed: people move, and
    // people order to their mum's.
    const saved = state?.savedAddress;
    const savedGuidance = saved?.line1
      ? `\nTHIS CALLER HAS ORDERED BEFORE\nTheir name is ${state?.knownName ?? "not recorded"} and their last delivery address was ${[saved.line1, saved.city, saved.postcode].filter(Boolean).join(", ")}.\n- If they want delivery, do NOT ask for the address from scratch. Ask "Are you still at ${saved.line1}?" and wait.\n- If yes: call use_saved_address. It is already confirmed — you do not need to read it back again.\n- If no: take a new address the normal way, with the read-back.\n- Do not use their name more than twice in the call. More than that is unsettling, not friendly.`
      : "";

    // A line that cheerfully takes an order from a closed shop is worse than
    // one that doesn't answer: the customer waits for food nobody is cooking.
    const open = ctx.openingHours
      ? isCurrentlyOpen(ctx.openingHours, ctx.timezone || "Europe/London")
      : true;
    const closedGuidance = open
      ? ""
      : `\nTHE SHOP IS CLOSED RIGHT NOW\nSay so in your first reply, plainly and without apology-spiralling. Tell them when it opens using get_opening_hours. Do NOT take an order for now. Offer to take a message instead, and use take_message. If they want to order for later, transfer them to the shop — you cannot schedule orders.`;

    return `You are answering the telephone for ${ctx.locationName}, a takeaway. You are speaking out loud to a customer on a phone call. You take orders, answer questions, and hand over to a human when you should.

HOW TO SPEAK
Everything you write is read aloud by a speech engine, so write it the way a person talks.
- Short sentences. No markdown, no bullet points, no emoji, no headings, no lists.
- Say prices as words in ${currencyName(ctx.currency)}: for example "four ${currencyName(ctx.currency)} fifty", never the written form.
- Ask ONE question at a time and wait. The caller cannot scroll back or re-read you.
- Never read the whole menu out. If asked what you do, name two or three popular things and ask what they fancy.
- Keep your turns to a sentence or two. A long speech on the phone is unbearable.

THE ORDER OF THE CALL
The caller has already chosen to place an order, and has already been asked whether it is collection or delivery. Work through these in order and do not skip one:
1. Collection or delivery.
2. If DELIVERY: the address (see below). If COLLECTION: go straight to step 3.
3. What they would like. Take the whole order.
4. Read the order back and get a yes.
5. How they want to pay: cash or card.
6. Place it.
Do not ask for anything twice, and do not ask for something you have already been told.

DELIVERY ADDRESSES — POSTCODE FIRST, ALWAYS
NEVER ask for a whole address in one go. A transcriber has never heard of their street and will mangle it; a postcode is six characters from a fixed alphabet, and their street can be looked up from it. Ask one short question at a time, in this order, and nothing else:
1. "What's your postcode?" — that alone. Then call lookup_postcode with what they said. If they gave you the whole address anyway, still call lookup_postcode with all of it: it finds the postcode inside the sentence.
2. lookup_postcode gives you the street. Say "That's <street>, <town> — is that right?" and wait.
3. Yes: "And the house number or name?" Take just that.
   No: "Sorry about that. What's the street name and house number?" Take both from them — they know their street, the database evidently does not. Never ask for the postcode a second time; they already gave you that.
4. Call propose_delivery_address with the house number and street and the postcode from step 1. It reads the whole thing back for you — say exactly what it gives you and wait.
5. Only when they say yes, call confirm_delivery_address. That is what sets the delivery charge, and place_order refuses until you have.
Never argue with a caller about their own address.
${deliveryGuidance}

TAKING AN ORDER
- People order fast and in bursts: "three cokes, a garlic bread and two pepperoni". Take the WHOLE burst in one turn — call add_item once per item, then say back what you have. Asking a question after every single item is what makes a four-item order feel like an interrogation.
- Pass the caller's own words in the said field, quantity included. They are matched against the menu for you, and that matching is built for exactly the way transcription mangles food names. You do not need the id.
- The transcript WILL be wrong about food. If what you heard does not obviously match one dish, call find_item before adding anything: it will either tell you which dish it is, or tell you it cannot choose.
- When it cannot choose, ask the caller which of the two they meant. Never pick for them — a wrong guess here is a wrong meal cooked.
- If an item has a REQUIRED option group, ask for that choice before adding it — one group at a time, offering at most three options aloud.
- Never invent a dish, a price, or an option that is not on the menu below. If they ask for something you do not have, say so plainly and suggest the closest thing you do have.

BEFORE YOU PLACE ANYTHING
Call read_back_order, then say exactly what it gives you back and wait for a yes. This is not optional and there is no version of this call where you skip it. A wrong order that reaches the kitchen is the worst thing you can do, and place_order will refuse until they have confirmed.

PAYING
After they confirm the order, ask: "How would you like to pay — cash, or card?"
- CASH: place it and tell them the time. Nothing else to do.
- CARD: place it with paymentMethod CARD. We text them a payment link. Say "I'm sending you a payment link now" and, once it has gone, "That's sent — you can pay on your phone. Thanks, and goodbye." Never ask for card numbers out loud, ever, no matter what they offer.

WHEN YOU DO NOT UNDERSTAND
Not understanding is NEVER a reason to hand over or hang up. It is a reason to ask again, differently. A caller who has to repeat themselves is mildly annoyed; a caller who gets cut off has been failed, and they will not ring back.
Work down this list, changing what you ask each time — never repeat the same words twice:
1. "Sorry, I didn't catch that — could you say it again?"
2. Ask for a smaller piece of it. For an address, take the postcode on its own first, then the house number, then the street.
3. Ask them to spell the difficult part, or to say it slowly.
4. Offer them a way round it: collection instead of delivery, or the shop ringing them back.
Only after all of that, and only if they are getting nowhere, offer to put them through. Ask first — "would you like me to put you through to the shop?" — rather than doing it to them.

WHEN TO HAND OVER TO A HUMAN
Use transfer_to_staff when: they ask for a person, they are upset or complaining, they are asking about an existing order you cannot find, or they want something you genuinely cannot do. Handing over for those is never a failure.
If nobody can take the call, use take_message instead so the shop can ring them back. Never end a call on an order you have not placed without offering one of those two.

THINGS TO GET RIGHT
- Confirm the caller's name before placing an order, and spell back anything unusual.
- If they go quiet, ask once if they are still there.
- If they say something you did not catch, ask them to repeat it — do not guess an order.
- If an address is outside the delivery area, say so and immediately offer collection, or ask whether there is another address they would like it sent to. Do not leave them with nowhere to go.
- Never promise a delivery time faster than the shop's own: about ${ctx.deliveryPrepMinutes} minutes for delivery, ${ctx.collectionPrepMinutes} for collection.

${savedGuidance}${closedGuidance}

MENU
${menu || "(no items available — apologise and transfer)"}`;
  }

  // ── Tools ───────────────────────────────────────────────────────────────

  private toolDefs(ctx: VoiceContext): Anthropic.Tool[] {
    return [
      {
        name: "find_item",
        description:
          "Check what a caller meant before adding it. Use whenever what you heard doesn't obviously match one dish — the transcription is often wrong about food names. Returns the closest menu items.",
        input_schema: {
          type: "object",
          properties: {
            said: { type: "string", description: "What the caller said, as you heard it" },
          },
          required: ["said"],
        },
      },
      {
        name: "add_item",
        description:
          "Add one menu item to the order. Pass `said` with the caller's own words and it will be matched against the menu — you do not need the exact id, and matching handles mis-heard names. Ask for any REQUIRED option group before calling this. Callers list several things at once; call this once per item in the SAME turn rather than asking after each one.",
        input_schema: {
          type: "object",
          properties: {
            said: {
              type: "string",
              description:
                "The caller's own words for this one item, including any quantity — e.g. 'three cola', 'large pepperoni'. Preferred over itemId.",
            },
            itemId: { type: "string", description: "Exact item id from the menu, if you are sure of it" },
            quantity: { type: "integer", minimum: 1, default: 1 },
            modifierOptionIds: {
              type: "array",
              items: { type: "string" },
              description: "Chosen option ids, exactly as listed in the menu",
            },
            notes: { type: "string", description: "e.g. no onions" },
          },
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
          "Record whether this is collection or delivery. Call it as soon as they tell you. For delivery the address is taken separately, with propose_delivery_address.",
        input_schema: {
          type: "object",
          properties: {
            type: { type: "string", enum: ["DELIVERY", "PICKUP"] },
          },
          required: ["type"],
        },
      },
      {
        name: "lookup_postcode",
        description:
          "Turn a postcode into a street. ALWAYS use this before taking a delivery address — never ask the caller to say their street. Pass whatever they said, even a whole address; the postcode is found inside it.",
        input_schema: {
          type: "object",
          properties: {
            said: { type: "string", description: "What the caller said when asked for their postcode" },
          },
          required: ["said"],
        },
      },
      {
        name: "propose_delivery_address",
        description:
          "The address you just heard, before you have read it back. Returns the exact words to say to the caller. Say them, then wait for a yes.",
        input_schema: {
          type: "object",
          properties: {
            line1: { type: "string", description: "House number and street" },
            city: { type: "string" },
            postcode: { type: "string" },
            area: {
              type: "string",
              description:
                "The named community, e.g. Dubai Marina. Use instead of postcode where the shop delivers by area.",
            },
          },
          required: ["line1"],
        },
      },
      {
        name: "confirm_delivery_address",
        description:
          "The caller has heard the address read back and said it is right. ONLY call this after they have confirmed out loud. This sets the delivery charge.",
        input_schema: { type: "object", properties: {} },
      },
      {
        name: "use_saved_address",
        description:
          "The caller confirmed they are still at the address we already have on file for them. Only available when the call notes give you one.",
        input_schema: { type: "object", properties: {} },
      },
      {
        name: "read_back_order",
        description:
          "Get the exact words to read the whole order back. Say them, then wait for a yes. place_order will refuse until they have confirmed.",
        input_schema: { type: "object", properties: {} },
      },
      {
        name: "order_confirmed",
        description:
          "The caller has heard the whole order read back and said yes. Only call this after they have confirmed out loud.",
        input_schema: { type: "object", properties: {} },
      },
      {
        name: "check_delivery_area",
        description:
          "Check whether the shop delivers somewhere, and what the fee is. Always call this before taking a full delivery address. Pass `area` where the shop delivers by area, `postcode` otherwise.",
        input_schema: {
          type: "object",
          properties: {
            postcode: { type: "string" },
            area: { type: "string", description: "The named community, e.g. Dubai Marina" },
          },
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
        name: "amend_order",
        description:
          "Add the items now on the order to an order the caller placed earlier. Only available while changing an existing order. Read the WHOLE order back and get a yes first, exactly as you would before placing one.",
        input_schema: { type: "object", properties: {} },
      },
      {
        name: "place_order",
        description:
          "Place the order. Only after order_confirmed, and after asking how they want to pay.",
        input_schema: {
          type: "object",
          properties: {
            customerName: { type: "string" },
            paymentMethod: {
              type: "string",
              enum: ["CASH", "CARD"],
              description:
                "CASH = pay at the shop or on delivery. CARD = we text them a payment link and the order waits for payment.",
            },
            notes: { type: "string", description: "Allergies, door instructions" },
          },
          // Both required: an order placed without knowing how it is being
          // paid for is one the shop has to ring the customer back about.
          required: ["customerName", "paymentMethod"],
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
  ): Promise<{ result: string; turn?: Partial<VoiceTurn>; sayNow?: string }> {
    switch (name) {
      case "find_item":
        return { result: this.findItem(String(input?.said ?? ""), ctx) };
      case "add_item":
        return { result: this.addItem(input, ctx, state) };
      case "remove_item": {
        const before = state.cart.items.length;
        state.cart.items = state.cart.items.filter((l) => l.lineId !== String(input?.lineId));
        return {
          result:
            state.cart.items.length < before
              ? `Removed. Order is now:\n${summarizeCart(state.cart, ctx.currency)}`
              : "That line isn't on the order.",
        };
      }
      case "set_fulfillment": {
        const type = input?.type === "PICKUP" ? "PICKUP" : "DELIVERY";
        state.cart.fulfillmentType = type;
        state.cart.fulfillmentChosen = true;
        if (type === "PICKUP") {
          // Switching to collection drops any address work, so a caller who
          // changes their mind halfway can't leave a stale confirmed address
          // behind on the order.
          state.cart.deliveryAddress = undefined;
          state.addressConfirmed = false;
          return {
            result: `Set to collection. Ask what they would like to order.`,
          };
        }
        if (state.savedAddress?.line1) {
          return {
            result: `Set to delivery. This caller has an address on file: ${[
              state.savedAddress.line1,
              state.savedAddress.city,
              state.savedAddress.postcode,
            ]
              .filter(Boolean)
              .join(", ")}. Ask "are you still at ${state.savedAddress.line1}?" — do not read the whole thing out.`,
          };
        }
        return {
          result:
            "Set to delivery. Now ask for their address including the postcode, giving the example, then call propose_delivery_address.",
        };
      }

      case "lookup_postcode":
        return { result: await this.lookupPostcode(String(input?.said ?? ""), ctx, state) };
      case "propose_delivery_address": {
        // An address needs whatever locates it here — a postcode in the UK, a
        // community in the Gulf. Requiring a postcode meant a Dubai caller
        // could never get past this, and the order was stamped "GB" besides.
        const line1 = String(input?.line1 ?? "").trim();
        if (!line1) {
          return { result: "No street or house number heard — ask again." };
        }
        // A real call gave us "E10, 8YH" for a caller who said "NE10 8YH" —
        // the leading letter did not survive the audio. If the shop delivers
        // to exactly one area whose outward code ends with what we heard, that
        // is not a guess, it is the only possibility. Two candidates and we
        // say nothing and let them be asked again.
        const heard = input?.postcode ? String(input.postcode) : undefined;
        const postcode = heard
          ? (resolveHeardPostcode(
              heard,
              ctx.deliveryZones.map((z) => z.postcodePrefix),
            ) ?? undefined)
          : undefined;

        state.cart.fulfillmentType = "DELIVERY";
        state.cart.fulfillmentChosen = true;
        state.cart.deliveryAddress = {
          line1,
          city: String(input?.city ?? ctx.address?.city ?? ""),
          postcode,
          area: input?.area ? String(input.area) : undefined,
          country: ctx.country,
        };
        // Proposing a NEW address always un-confirms — otherwise a correction
        // inherits the yes the caller gave to the address they just rejected.
        state.addressConfirmed = false;

        const spoken = this.spokenAddress(state.cart.deliveryAddress);
        state.awaiting = "ADDRESS_CONFIRM";
        return {
          result:
            "Address taken and read back to the caller. Wait for their answer. Call confirm_delivery_address only if they say yes; if they say no, take it again.",
          sayNow: `So that's ${spoken}. Is that correct?`,
        };
      }

      case "confirm_delivery_address": {
        const addr = state.cart.deliveryAddress;
        if (!addr?.line1) {
          return { result: "There is no address to confirm — take one first." };
        }
        // The fee is quoted from the same resolver every other surface uses,
        // at the moment the address is finally agreed — not from whatever was
        // guessed earlier in the call.
        const check = this.checkArea(
          zoneMode(ctx.deliveryZones as any) === "AREA"
            ? String(addr.area ?? "")
            : String(addr.postcode ?? ""),
          ctx,
        );
        if (check.startsWith("The shop does NOT deliver")) {
          state.addressConfirmed = false;
          return { result: check };
        }
        state.addressConfirmed = true;
        return {
          result: `Address confirmed. ${check} Tell them the delivery charge, then ask what they would like to order.`,
        };
      }

      case "use_saved_address": {
        const saved = state.savedAddress;
        if (!saved?.line1) {
          return {
            result:
              "There is no saved address for this caller — take one the normal way.",
          };
        }
        state.cart.fulfillmentType = "DELIVERY";
        state.cart.fulfillmentChosen = true;
        state.cart.deliveryAddress = {
          line1: saved.line1,
          city: saved.city,
          postcode: saved.postcode || undefined,
          country: saved.country ?? ctx.country,
        };
        // Already confirmed: they ordered to it before and have just said they
        // are still there. Making them hear it read back a second time is the
        // kind of thing that makes a line feel like a form.
        state.addressConfirmed = true;
        // A saved address carries a postcode, not a named community, so in an
        // area-priced shop there is nothing here to check it against. Ask,
        // rather than quoting a fee resolved from the wrong field.
        if (zoneMode(ctx.deliveryZones as any) === "AREA") {
          return {
            result:
              "Using their saved address. Ask which area that is in and run check_delivery_area before quoting a delivery charge.",
          };
        }
        const check = this.checkArea(String(saved.postcode ?? ""), ctx);
        return {
          result: `Using their saved address. ${check} Now ask what they would like to order.`,
        };
      }

      case "read_back_order": {
        if (state.cart.items.length === 0) {
          return { result: "Nothing on the order yet — there is nothing to read back." };
        }
        state.awaiting = "ORDER_CONFIRM";
        return {
          result:
            "Order read back to the caller. Wait for their answer. Call order_confirmed if they say yes; if they say no, ask what needs changing.",
          sayNow: this.readBackScript(ctx, state),
        };
      }

      case "order_confirmed": {
        if (state.cart.items.length === 0) {
          return { result: "The order is empty — nothing to confirm." };
        }
        state.orderConfirmed = true;
        return {
          result:
            "Confirmed. Now ask how they would like to pay — cash, or card — and then place it.",
        };
      }
      case "check_delivery_area":
        return {
          result: this.checkArea(
            String(input?.area ?? input?.postcode ?? ""),
            ctx,
          ),
        };
      case "get_opening_hours":
        return { result: this.openingHours(ctx) };
      case "get_order_status":
        return { result: await this.orderStatus(ctx, callerNumber, input?.orderNumber) };
      case "amend_order":
        return this.amendOrder(ctx, state);
      case "place_order":
        // An amendment is not a new order. Placing one here would leave the
        // caller with two — the one they rang about and a duplicate of it
        // carrying the extras.
        if (state.amendOrderId) {
          return {
            result:
              "This caller is CHANGING an order that already exists. Use amend_order, not place_order.",
          };
        }
        return this.placeOrder(input, ctx, state, callerNumber);
      case "take_message": {
        state.message = String(input?.message ?? "").slice(0, 1000);
        return {
          result: "Message saved for the shop.",
          turn: { outcome: "ENQUIRY" },
        };
      }
      case "transfer_to_staff": {
        // Handing over because WE could not hear is the failure this line was
        // built to avoid. The caller rang a shop that did not answer; being
        // bounced by the thing that did answer, over a word, is worse than
        // either. A real request for a person always goes through — this only
        // ever refuses "I keep mishearing them".
        const why = String(input?.reason ?? "").toLowerCase();
        const onlyMisheard =
          /(mishear|misheard|not understand|didn'?t understand|can'?t understand|unclear|couldn'?t catch|didn'?t catch|hard to hear|trouble hearing)/.test(
            why,
          );
        if (onlyMisheard && !state.askedForHuman && (state.confusion ?? 0) < 3) {
          state.confusion = (state.confusion ?? 0) + 1;
          return {
            result:
              "Not yet. Mishearing is not a reason to hand over — ask again, in DIFFERENT words, and ask for a smaller piece of it than last time. Take a postcode on its own, or ask them to spell it. If you still cannot get there after a few goes, ASK them whether they would like to be put through rather than doing it to them.",
          };
        }
        return {
          result: ctx.transferNumber
            ? "Transferring now."
            : "No transfer number configured — take a message instead.",
          turn: ctx.transferNumber
            ? { transferTo: ctx.transferNumber, outcome: "TRANSFERRED" }
            : undefined,
        };
      }
      case "end_call": {
        // Never hang up on a basket. Somebody spent that call choosing food.
        if (state.cart.items.length > 0 && !state.orderId) {
          return {
            result:
              "There is an unplaced order on this call. Do not hang up. Either finish placing it, or offer to take a message so the shop can ring them back.",
          };
        }
        return { result: "Ending call.", turn: { endCall: true } };
      }
      default:
        return { result: `Unknown tool ${name}` };
    }
  }

  /** What could the caller have meant? Offered to the model before it commits. */
  private findItem(said: string, ctx: VoiceContext): string {
    const { rest } = splitQuantity(said);
    const matches = matchMenuItems(rest || said, ctx.items, { limit: 4 });
    if (!matches.length) {
      return `Nothing on the menu matches "${said}". Tell them plainly that you don't have it and offer the closest thing you DO have.`;
    }
    if (isConfident(matches)) {
      const top = matches[0]!.item;
      return `That's ${top.name} [${top.id}]. Add it with add_item.`;
    }
    return `Not sure between: ${matches
      .map((m) => `${m.item.name} [${m.item.id}]`)
      .join(", ")}. Ask the caller which one — do not choose for them.`;
  }

  private addItem(input: any, ctx: VoiceContext, state: VoiceState): string {
    // The caller's own words are the better input. A transcriber that has
    // never seen this menu turns "three cola" into "Drie coli", and asking a
    // model to pick an exact id out of that leaves it guessing or asking
    // again — one puts the wrong food in the kitchen, the other is what makes
    // a four-item order take two minutes.
    let item = ctx.itemIndex.get(String(input?.itemId ?? ""));
    let quantityFromSpeech: number | undefined;

    if (!item && input?.said) {
      const { quantity, rest } = splitQuantity(String(input.said));
      quantityFromSpeech = quantity;
      const matches = matchMenuItems(rest, ctx.items, { limit: 3 });
      if (!matches.length) {
        return `Nothing on the menu matches "${input.said}". Say plainly that you don't have it, and offer the closest thing you do.`;
      }
      if (!isConfident(matches)) {
        // Two plausible dishes is a question for the caller, not a coin toss
        // on their behalf — and getting it wrong here is a wrong meal cooked.
        return `More than one thing matches "${input.said}": ${matches
          .map((m) => m.item.name)
          .join(" or ")}. Ask which one they meant, then add it.`;
      }
      item = matches[0]!.item;
    }

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
      quantity: Math.max(
        1,
        Math.round(Number(input?.quantity) || quantityFromSpeech || 1),
      ),
      unitBasePrice: item.price,
      modifiers,
      notes: input?.notes ? String(input.notes) : undefined,
    };
    state.cart.items.push(line);
    return `Added ${line.quantity} × ${item.name} at ${money(
      lineUnitPrice(line),
      ctx.currency,
    )} each.\nOrder so far:\n${summarizeCart(state.cart, ctx.currency)}`;
  }

  /**
   * An address as it should be SAID back, not as it would be printed.
   *
   * The postcode is spaced out — "N E 10, 8 Y H" — because a speech engine
   * reads "NE10 8YH" as a single mangled word, and the entire point of the
   * read-back is that the caller can check it.
   */
  private spokenAddress(addr?: {
    line1?: string;
    city?: string;
    postcode?: string;
    area?: string;
  }): string {
    if (!addr) return "";
    const parts = [addr.line1, addr.city, addr.area].filter(Boolean);
    const pc = String(addr.postcode ?? "").trim();
    if (pc) parts.push(pc.toUpperCase().split("").join(" ").replace(/\s{2,}/g, ", "));
    return parts.join(", ");
  }

  /**
   * The words to read the order back in.
   *
   * Built here rather than left to the model because this is the moment the
   * whole call is judged on: every line, the delivery charge if there is one,
   * and the total the caller is actually going to pay. A model paraphrasing
   * its own cart is how an item quietly goes missing between the conversation
   * and the kitchen.
   */
  private readBackScript(ctx: VoiceContext, state: VoiceState): string {
    const lines = state.cart.items
      .map((l) => {
        const mods = l.modifiers.length
          ? ` with ${l.modifiers.map((m) => m.name).join(" and ")}`
          : "";
        const qty = l.quantity > 1 ? `${l.quantity} ` : "";
        return `${qty}${l.name}${mods}${l.notes ? `, ${l.notes}` : ""}`;
      })
      .join(", then ");

    const isDelivery = state.cart.fulfillmentType === "DELIVERY";
    const subtotal = cartSubtotal(state.cart);
    const fee = isDelivery ? this.feeForAddress(state.cart.deliveryAddress, ctx) : 0;
    const feeLine = fee > 0 ? ` plus ${money(fee, ctx.currency)} delivery` : "";
    const where = isDelivery
      ? `for delivery to ${this.spokenAddress(state.cart.deliveryAddress)}`
      : "for collection";

    // Bare speech: this is spoken to the caller verbatim, not handed to the
    // model to repeat. That is what makes the read-back trustworthy — the
    // prices and lines are the cart's, not a paraphrase of it.
    return `So that's ${lines}, ${where}.${feeLine} That comes to ${money(
      round2(subtotal + fee),
      ctx.currency,
    )}. Is that all correct?`;
  }

  /** Answer "do you deliver to X?" — where X is a postcode or a community,
   *  depending on how the shop actually prices delivery. */
  private checkArea(where: string, ctx: VoiceContext): string {
    const mode = zoneMode(ctx.deliveryZones as any);
    const asked = (where ?? "").trim();
    if (!asked) {
      return mode === "AREA"
        ? "Ask them which area they are in."
        : "Ask them for the postcode.";
    }
    const match = resolveZone(ctx.deliveryZones as any, {
      postcode: mode === "AREA" ? undefined : asked,
      area: mode === "AREA" ? asked : undefined,
    });
    if (!match.matched) {
      return `The shop does NOT deliver to ${asked}. Tell them, and offer collection instead.`;
    }
    return `Delivers to ${match.label ?? asked}. Fee ${money(match.fee, ctx.currency)}${
      match.minOrderValue
        ? `, minimum order ${money(match.minOrderValue, ctx.currency)}`
        : ""
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
      // Order.orderNumber is an Int. Handing Prisma the digits as a STRING is
      // not a near miss it coerces — it throws, the turn dies, and the caller
      // who just carefully read out their number hears an apology instead of
      // their order. Anything that is not a plausible order number is treated
      // as "no number given" rather than crashing the turn.
      const n = Number(String(orderNumber).replace(/\D/g, ""));
      if (!Number.isSafeInteger(n) || n <= 0) {
        return "That isn't a number I can look up. Ask them to read it out again, digit by digit.";
      }
      where.orderNumber = n;
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
        estimatedReadyAt: true,
      },
    });
    if (!order) {
      return "No recent order found for this caller. Offer to transfer them to the shop.";
    }
    const mins = order.estimatedReadyAt
      ? Math.max(0, Math.round((new Date(order.estimatedReadyAt).getTime() - Date.now()) / 60000))
      : null;
    return `Order ${order.orderNumber}, status ${order.status}, ${order.fulfillmentType}, total ${money(
      Number(order.total),
      ctx.currency,
    )}${mins != null ? `, about ${mins} minutes away` : ""}.`;
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
    // The two locks. The system prompt asks for both read-backs; a prompt is a
    // request, and these are the two failures that get an AI phone line
    // switched off permanently — food nobody ordered, and a driver at the
    // wrong door. So they are enforced here, where the model cannot talk its
    // way past them.
    if (!state.orderConfirmed) {
      return {
        result:
          "You have not read the order back yet. Call read_back_order, say it, and get a yes before placing anything.",
      };
    }
    const isDelivery = state.cart.fulfillmentType === "DELIVERY";
    // What counts as "we have an address" follows the shop, not the UK.
    const located =
      zoneMode(ctx.deliveryZones as any) === "AREA"
        ? !!state.cart.deliveryAddress?.area
        : !!state.cart.deliveryAddress?.postcode ||
          !postcodeRequiredFor(ctx.country);
    if (isDelivery && !(state.cart.deliveryAddress?.line1 && located)) {
      return { result: "You need a delivery address first. Ask for it." };
    }
    if (isDelivery && !state.addressConfirmed) {
      return {
        result:
          "The address has not been read back and confirmed. Read it back, wait for a yes, then call confirm_delivery_address.",
      };
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
      ? this.feeForAddress(state.cart.deliveryAddress, ctx)
      : 0;
    const isCard = String(input?.paymentMethod ?? "").toUpperCase() === "CARD";

    try {
      const order: any = await this.orders.create(
        {
          locationId: ctx.locationId,
          ...(ctx.brandId ? { brandId: ctx.brandId } : {}),
          // VOICE, not "PHONE" — the latter is in neither OrderPlatform nor
          // OrderSource, so every completed call used to fail at the Prisma
          // write and the caller was told their order could not be saved
          // AFTER they had confirmed it.
          orderSource: "VOICE",
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
          // PAYMENT_LINK, not CARD. The board's "Waiting for payment" column
          // matches PAYMENT_LINK / QR_CODE / CARD_TERMINAL, so a card order
          // marked plain CARD sat in New as though it were paid for, and the
          // kitchen cooked it before the link had been opened.
          paymentMethod: isCard ? "PAYMENT_LINK" : "CASH",
          paymentStatus: "PENDING",
          // Keyed on the CALL, not the turn count. With turns.length in the
          // key, a retry one turn later produced a different key and a second
          // real order for the same food.
          idempotencyKey: `voice-${state.callId ?? `${ctx.locationId}-${normaliseNumber(
            callerNumber,
          )}`}-${Math.round(subtotal * 100)}`,
        } as any,
        ctx.tenantId,
      );
      state.orderId = order.id;

      // Remember where they live, so the next call is one yes instead of a
      // recited address. After the order exists, deliberately: an abandoned
      // call should not leave address rows behind.
      if (isDelivery) {
        await this.rememberAddress(ctx, callerNumber, state);
      }

      let extra = "";
      if (isCard && callerNumber) {
        extra = await this.textPaymentLink(ctx, order, callerNumber);
      } else if (isCard) {
        extra =
          " We have no number for this caller, so no payment link could be sent — tell them they can pay at the shop.";
      } else {
        extra = await this.textReceipt(ctx, order, callerNumber);
      }

      const mins = isDelivery ? ctx.deliveryPrepMinutes : ctx.collectionPrepMinutes;
      return {
        // The number is spelled out digit by digit because the caller may well
        // ring back and quote it, and "four thousand and twelve" is not
        // something they can match to a text message.
        result: `Order placed. Read the order number back to them as separate digits: ${spokenDigits(
          order.orderNumber ?? "",
        )}. Total ${money(
          round2(subtotal + deliveryFee),
          ctx.currency,
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

  /**
   * Apply the caller's additions to the order they rang about.
   *
   * Goes through OrdersService.editOrder rather than writing items directly,
   * because that is where the rules about WHEN an order may still be changed
   * live: not past Ready, and not once the money has moved. Those are the
   * shop's rules, not this line's, and a phone call is not a reason to have a
   * different set.
   */
  private async amendOrder(
    ctx: VoiceContext,
    state: VoiceState,
  ): Promise<{ result: string; turn?: Partial<VoiceTurn> }> {
    if (!state.amendOrderId) {
      return { result: "There is no existing order being changed here." };
    }
    if (!state.orderConfirmed) {
      return {
        result:
          "You have not read the whole order back yet. Call read_back_order, say it, and get a yes — the same as before placing one.",
      };
    }

    const items = state.cart.items.map((l) => ({
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
    const isDelivery = state.cart.fulfillmentType === "DELIVERY";
    const deliveryFee = isDelivery
      ? this.feeForAddress(state.cart.deliveryAddress, ctx)
      : 0;

    try {
      await this.orders.editOrder(
        state.amendOrderId,
        ctx.tenantId,
        {
          items,
          subtotal,
          ...(deliveryFee > 0 ? { deliveryFee } : {}),
          total: round2(subtotal + deliveryFee),
        } as any,
        // The change was made by the phone line, not by a member of staff.
        // The audit trail should say so.
        "voice-ai",
      );
      const done = state.amendOrderId;
      state.amendOrderId = undefined;
      return {
        result: `Order ${state.amendReference ?? done} updated. Tell them it's been added and the kitchen has the new ticket.`,
        turn: { orderId: done, outcome: "ORDER" },
      };
    } catch (e: any) {
      // editOrder refuses for good reasons — past Ready, already paid by card.
      // Say what it said rather than inventing an explanation, and get them a
      // person, because from here only a human can help.
      this.logger.warn(`Voice amend failed for ${state.amendOrderId}: ${e?.message}`);
      return {
        result: `That order can't be changed now: ${
          e?.message ?? "it has gone too far through the kitchen"
        }. Tell them plainly and offer to put them through to the shop.`,
        turn: { transferTo: ctx.transferNumber ?? undefined, outcome: "TRANSFERRED" },
      };
    }
  }

  /**
   * Load an existing order into the cart so the caller can add to it.
   *
   * Everything already on the order comes across, because editOrder replaces
   * the item list wholesale — send only the additions and the customer loses
   * the food they actually ordered.
   */
  loadOrderForAmend(
    state: VoiceState,
    order: {
      id: string;
      reference: string;
      fulfillmentType?: string | null;
      items: Array<{
        name: string;
        quantity: number;
        unitPrice: number | string;
        notes?: string | null;
      }>;
    },
  ): void {
    state.amendOrderId = order.id;
    state.amendReference = order.reference;
    state.orderConfirmed = false;
    state.cart.fulfillmentType = order.fulfillmentType === "DELIVERY" ? "DELIVERY" : "PICKUP";
    state.cart.fulfillmentChosen = true;
    state.cart.items = order.items.map((it) => ({
      lineId: Math.random().toString(36).slice(2, 9),
      itemId: "",
      name: String(it.name),
      quantity: Math.max(1, Math.round(Number(it.quantity) || 1)),
      unitBasePrice: Number(it.unitPrice) || 0,
      modifiers: [],
      ...(it.notes ? { notes: String(it.notes) } : {}),
    }));
  }

  /** The delivery fee for whatever address the caller gave.
   *
   *  Same resolver as every other surface. Distance bands quote the TOP band
   *  here — a phone call collects no coordinates — and orders.create re-prices
   *  them from the address, so the caller is never quoted less than they pay. */
  private feeForAddress(
    address: { postcode?: string; area?: string } | undefined,
    ctx: VoiceContext,
  ): number {
    return resolveZone(ctx.deliveryZones as any, {
      postcode: address?.postcode,
      area: address?.area,
    }).fee;
  }

  /**
   * Keep the delivery address against the customer, so the next call is one
   * yes instead of a recited address.
   *
   * Never throws into the call. A CRM write failing is not a reason for a
   * caller who has just successfully ordered to hear an apology — the order is
   * already in, and this is a convenience for next time.
   */
  private async rememberAddress(
    ctx: VoiceContext,
    callerNumber: string | null | undefined,
    state: VoiceState,
  ): Promise<void> {
    const addr = state.cart.deliveryAddress;
    const phone = normaliseNumber(callerNumber);
    if (!addr?.line1 || !phone) return;

    try {
      const customer = await this.db().customer.upsert({
        where: { tenantId_phone: { tenantId: ctx.tenantId, phone: `+${phone}` } },
        update: {},
        create: {
          tenantId: ctx.tenantId,
          phone: `+${phone}`,
          firstName: state.knownName ?? null,
        },
        select: { id: true },
      });

      // Don't stack a duplicate row every time they order to the same place.
      const line1 = String(addr.line1);
      const postcode = String(addr.postcode ?? "");
      const existing = await this.db().customerAddress.findFirst({
        where: { customerId: customer.id, line1, postcode },
        select: { id: true },
      });
      if (existing) return;

      await this.db().customerAddress.create({
        data: {
          customerId: customer.id,
          label: "Phone order",
          line1,
          city: String(addr.city ?? ctx.address?.city ?? ""),
          postcode,
          country: addr.country ?? ctx.country ?? "GB",
        },
      });
    } catch (e: any) {
      this.logger.warn(`Voice could not save caller address: ${e?.message ?? e}`);
    }
  }

  /**
   * A text confirming a cash order.
   *
   * OFF unless the shop turns it on (`voiceSmsReceipt`), because every one of
   * these spends real money out of their prepaid SMS wallet and nobody should
   * discover a new per-order cost by finding their balance empty. Card orders
   * already get the payment link and never get this as well.
   */
  private async textReceipt(
    ctx: VoiceContext,
    order: any,
    to: string | null | undefined,
  ): Promise<string> {
    if (!ctx.smsReceipt || !to) return "";
    try {
      await this.sms.send({
        tenantId: ctx.tenantId,
        to,
        body: `${ctx.locationName}: order ${order.orderNumber} confirmed, ${money(
          Number(order.total ?? 0),
          ctx.currency,
        )}. Thanks for calling.`,
        purpose: "OTHER",
        locationId: ctx.locationId,
        brandId: ctx.brandId ?? null,
        orderId: order.id,
      });
      return " A confirmation text has been sent.";
    } catch (e: any) {
      this.logger.warn(`Voice receipt SMS failed for ${order.id}: ${e?.message}`);
      return "";
    }
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
