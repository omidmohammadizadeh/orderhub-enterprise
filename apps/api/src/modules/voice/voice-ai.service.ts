import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Anthropic from '@anthropic-ai/sdk';
import {
  resolveZone,
  zoneMode,
  areaZoneNames,
  postcodeRequiredFor,
  currencyName,
} from '@orderhub/shared';
import { money } from '../whatsapp/whatsapp-cart';
import { PrismaService } from '../../infrastructure/database/prisma.service';
import { OrdersService } from '../orders/orders.service';
import { SmsService } from '../sms/sms.service';
import { PaymentsService } from '../payments/payments.service';
import { AddressLookupService } from '../address-lookup/address-lookup.service';
import {
  addressQuery,
  bestAddress,
  matchStreet,
  postcodeArea,
  rankAddresses,
  shopAreas,
  uniqueStreets,
  type AddressCandidate,
} from './voice-address';
import type { VoiceContext } from './voice-context.service';
import { normaliseNumber } from './voice-context.service';
import {
  addressLineFrom,
  stripPostcode,
  findPostcodeIn,
  houseNumberFrom,
  resolveHeardPostcode,
  spokenDigits,
  hasStreetType,
  looksLikeStreet,
  sameStreet,
  streetOf,
  type VoiceStage,
  numberedAsk,
  parseYesNo,
} from './voice-flow';
import {
  isConfident,
  isConfidentGroup,
  matchItemGroups,
  matchMenuItems,
  pickVariant,
  sizesAloud,
  splitSize,
  splitQuantity,
  matchOption,
  matchWithQuantity,
  segmentItems,
  explains,
  mustChoose,
  needed,
  saysOption,
} from './voice-menu-match';
import { isCurrentlyOpen } from '../../common/opening-hours.util';
import {
  coerceCart,
  cartSubtotal,
  emptyCart,
  lineTotal,
  lineUnitPrice,
  round2,
  summarizeCart,
  type WaCart,
} from '../whatsapp/whatsapp-cart';

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

const DEFAULT_MODEL = 'claude-sonnet-5';

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
  turns: Array<{ role: 'user' | 'assistant'; text: string }>;
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
   * A yes/no question that speech could not answer, moved to the keypad.
   *
   * The three tools that change what a kitchen cooks all turn on a yes, and a
   * transcriber that renders one as "Svensk." makes that yes unobtainable —
   * so once speech has failed the question is asked as 1-or-2 and answered by
   * a keypress, which cannot be misheard.
   */
  pendingConfirm?: {
    intent: 'usual' | 'address' | 'order';
    asked?: boolean;
    answered?: 'YES' | 'NO';
    /** What the question was ABOUT. A press for a basket that has since
     *  changed answers a question nobody is asking any more. */
    of?: string;
  };
  /**
   * Which version of the order each confirmation was given for.
   *
   * A flag alone goes stale the moment anything changes: "yes, that's all
   * correct" said about a pizza and chips does not cover the garlic bread
   * added afterwards, or the address corrected a minute later. The fingerprint
   * is the basket as it was when the words were said; a mismatch means the
   * confirmation is for a different order and does not count.
   */
  readBackOf?: string;
  orderConfirmedOf?: string;
  addressConfirmedOf?: string;
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
    | 'ADDRESS_CONFIRM'
    | 'ORDER_CONFIRM'
    | 'FULFILLMENT'
    | 'PAYMENT'
    | 'NAME'
    /** Asked for the whole address in one go — the default opening. */
    | 'ADDR_FULL'
    /** Asked for the postcode, nothing else yet. */
    | 'ADDR_POSTCODE'
    /** Read the street back off the postcode; waiting for yes or no. */
    | 'ADDR_STREET'
    /** Street agreed; waiting for the house number or name. */
    | 'ADDR_HOUSE'
    /** A dish is chosen and one of its required choices is outstanding. */
    | 'ITEM_OPTION'
    /** Every choice made; offering them a note before it goes in the cart. */
    | 'ITEM_NOTE'
    /** Offered them last time's order; waiting on yes or no. */
    | 'USUAL';
  /** The address being built up, one question at a time. `house` holds a
   *  number they gave BEFORE we could name the street, so it isn't asked for
   *  twice — "five signing their drive" is a five we already have. */
  addr?: { postcode?: string; street?: string; city?: string; house?: string };
  /** A dish chosen but not yet added, because it still needs a choice made
   *  about it. Most of a real takeaway menu has one. */
  pendingItem?: {
    /** Set once the exact variant is known. */
    itemId?: string;
    /** Set while the dish is certain but the size is not. */
    variantIds?: string[];
    quantity: number;
    chosen: string[];
    /** Answers to this dish's questions we could not read. */
    misses?: number;
    /** Anything the caller wants the kitchen to know about this line. */
    notes?: string;
    /** Whether we have already offered them the chance to add one. */
    notesAsked?: boolean;
    /** Whether we actually asked them anything about this dish. */
    walked?: boolean;
    /** A deal: what it comes with was said first, all choices invited at once. */
    overview?: boolean;
  };
  /**
   * What is on offer right now, in the order it was read out.
   *
   * Reading "press 1 for gyros, press 2 for halloumi" out loud costs about
   * seven seconds a question, against two and a half for asking the question
   * like a person — three questions on one meal is the difference between a
   * twelve-second order and a twenty-seven-second one, and a regular pays it
   * every single time. So the numbers are never read out, but they are always
   * live: the third option is always 3, whether or not anybody said so. A
   * caller in a noisy car presses it, everyone else just answers, and nobody
   * waits through a phone tree to order chips.
   */
  choices?: string[];
  /** Whether this caller has been told the keypad works. Once is enough. */
  toldAboutKeypad?: boolean;
  /** How they said they'd pay, held while we ask for a name. */
  pendingPayment?: 'CASH' | 'CARD';
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
  return { turns: [], cart: emptyCart(), stage: 'MENU' };
}

export function coerceState(raw: unknown): VoiceState {
  if (!raw || typeof raw !== 'object') return emptyState();
  const r = raw as any;
  return {
    turns: Array.isArray(r.turns)
      ? r.turns
          .filter((t: any) => t && (t.role === 'user' || t.role === 'assistant'))
          .map((t: any) => ({ role: t.role, text: String(t.text ?? '') }))
      : [],
    cart: coerceCart(r.cart),
    orderId: r.orderId ? String(r.orderId) : undefined,
    outcome: r.outcome ? String(r.outcome) : undefined,
    message: r.message ? String(r.message) : undefined,
    // Calls that were already in flight when this deployed have no stage.
    // They resume in ORDER rather than being sent back to a menu they have
    // already answered.
    stage: (['MENU', 'ORDER', 'STATUS', 'DONE'] as const).includes(r.stage) ? r.stage : 'ORDER',
    addressConfirmed: r.addressConfirmed === true,
    orderConfirmed: r.orderConfirmed === true,
    // Dropped here once, which cost a whole call: the keypad question was
    // asked and saved, this rebuilt the state without it, and the caller's
    // "2" arrived to find nothing waiting for it — so it was read as the main
    // menu's "press 2 for an order update" and they were transferred out of
    // their own order. Anything the caller is mid-answering has to survive a
    // reload, because the answer always arrives on a LATER event.
    pendingConfirm:
      r.pendingConfirm && typeof r.pendingConfirm === 'object'
        ? {
            intent: (['usual', 'address', 'order'] as const).includes(r.pendingConfirm.intent)
              ? r.pendingConfirm.intent
              : 'order',
            asked: r.pendingConfirm.asked === true,
            answered:
              r.pendingConfirm.answered === 'YES' || r.pendingConfirm.answered === 'NO'
                ? r.pendingConfirm.answered
                : undefined,
            of: r.pendingConfirm.of ? String(r.pendingConfirm.of) : undefined,
          }
        : undefined,
    readBackOf: r.readBackOf ? String(r.readBackOf) : undefined,
    orderConfirmedOf: r.orderConfirmedOf ? String(r.orderConfirmedOf) : undefined,
    addressConfirmedOf: r.addressConfirmedOf ? String(r.addressConfirmedOf) : undefined,
    savedAddress:
      r.savedAddress && typeof r.savedAddress === 'object'
        ? {
            line1: String(r.savedAddress.line1 ?? ''),
            city: String(r.savedAddress.city ?? ''),
            postcode: String(r.savedAddress.postcode ?? ''),
            country: r.savedAddress.country ? String(r.savedAddress.country) : undefined,
          }
        : undefined,
    knownName: r.knownName ? String(r.knownName) : undefined,
    pendingItem:
      r.pendingItem &&
      typeof r.pendingItem === 'object' &&
      (r.pendingItem.itemId || Array.isArray(r.pendingItem.variantIds))
        ? {
            itemId: r.pendingItem.itemId ? String(r.pendingItem.itemId) : undefined,
            variantIds: Array.isArray(r.pendingItem.variantIds)
              ? r.pendingItem.variantIds.map(String)
              : undefined,
            quantity: Number(r.pendingItem.quantity) || 1,
            chosen: Array.isArray(r.pendingItem.chosen) ? r.pendingItem.chosen.map(String) : [],
            misses: Number(r.pendingItem.misses) || 0,
            notes: r.pendingItem.notes ? String(r.pendingItem.notes) : undefined,
            notesAsked: r.pendingItem.notesAsked === true,
            walked: r.pendingItem.walked === true,
            overview: r.pendingItem.overview === true,
          }
        : undefined,
    choices: Array.isArray(r.choices) ? r.choices.map(String) : undefined,
    toldAboutKeypad: r.toldAboutKeypad === true,
    pendingPayment:
      r.pendingPayment === 'CASH' || r.pendingPayment === 'CARD' ? r.pendingPayment : undefined,
    amendOrderId: r.amendOrderId ? String(r.amendOrderId) : undefined,
    amendReference: r.amendReference ? String(r.amendReference) : undefined,
    confusion: Number.isFinite(Number(r.confusion)) ? Number(r.confusion) : 0,
    askedForHuman: r.askedForHuman === true,
    callId: r.callId ? String(r.callId) : undefined,
    addr:
      r.addr && typeof r.addr === 'object'
        ? {
            postcode: r.addr.postcode ? String(r.addr.postcode) : undefined,
            street: r.addr.street ? String(r.addr.street) : undefined,
            city: r.addr.city ? String(r.addr.city) : undefined,
            house: r.addr.house ? String(r.addr.house) : undefined,
          }
        : undefined,
    awaiting: (
      [
        'ADDRESS_CONFIRM',
        'ORDER_CONFIRM',
        'FULFILLMENT',
        'PAYMENT',
        'NAME',
        'ADDR_FULL',
        'ADDR_POSTCODE',
        'ADDR_STREET',
        'ADDR_HOUSE',
        'ITEM_OPTION',
        'ITEM_NOTE',
        'USUAL',
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
  private readonly parseModel: string;

  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
    private readonly orders: OrdersService,
    private readonly sms: SmsService,
    private readonly payments: PaymentsService,
    private readonly addresses: AddressLookupService,
  ) {
    const apiKey = this.config.get<string>('ANTHROPIC_API_KEY');
    this.anthropic = apiKey ? new Anthropic({ apiKey }) : null;
    if (!this.anthropic) {
      this.logger.warn('ANTHROPIC_API_KEY not set — AI phone line disabled');
    }
    // Latency is the binding constraint on a phone call, not raw capability:
    // a caller notices a one-second pause. Configurable so the tier can be
    // tuned against real call recordings.
    this.model = this.config.get<string>('VOICE_MODEL') || DEFAULT_MODEL;
    // parse_order is an extraction, not a conversation: 2.2 seconds of Sonnet
    // mid-turn is a pause the caller hears. Haiku does it in a fraction.
    this.parseModel = this.config.get<string>('VOICE_PARSE_MODEL') || 'claude-haiku-4-5-20251001';
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
    const who = knownName ? `Hello ${knownName}, welcome back to` : 'Hello and welcome to';
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
      'To place an order, press 1.',
      'For an update on an order, press 2.',
      "To change an order you've already placed, press 3.",
      'To report a problem with an order, press 4.',
      'To hear these again, press 5.',
    ].join(' ');
  }

  /** Option 3. */
  amendOpener(): string {
    return 'No problem. Can I have your order number?';
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
  /**
   * Somebody wants to change an order that was not placed with the shop.
   *
   * Sending them to the shop is the wrong answer, and it was the old one. The
   * shop cannot change an Uber Eats basket either — Uber Eats owns the order,
   * the payment and the refund, and a member of staff would just tell them the
   * same thing a minute later, after a transfer. The caller needs the app they
   * ordered on, and they need to be told so plainly.
   */
  amendElsewhere(via: string): string {
    return `That order was placed through ${via}, so it has to be changed there — the shop can't do it from this end. Have a look in the ${via} app or on their website, under your order.`;
  }

  /**
   * Somebody wants to change an order the kitchen has already finished.
   *
   * Said in whatever terms are actually true of it: telling a caller their
   * order "is ready" when it left with a driver ten minutes ago is a small lie
   * that produces a complaint, and telling them it is ready when it has
   * already been eaten is worse.
   */
  amendTooLate(status: string, delivery: boolean): string {
    switch (status) {
      case 'READY':
        return delivery
          ? "Sorry, that one's already made up and waiting for a driver, so I can't add to it."
          : "Sorry, that one's already made up and waiting for you, so I can't add to it.";
      case 'OUT_FOR_DELIVERY':
      case 'DISPATCHED':
      case 'RIDER_ARRIVED':
      case 'ASSIGNED_DRIVER':
      case 'ACCEPTED_BY_DRIVER':
      case 'PENDING_DISPATCH':
        return "Sorry, that one's already on its way to you, so I can't add to it.";
      case 'COMPLETED':
        return delivery
          ? "That one's already been delivered, so I can't add to it."
          : "That one's already been collected, so I can't add to it.";
      case 'CANCELLED':
      case 'REJECTED':
      case 'FAILED':
        return "That order has been cancelled, so there's nothing to add to.";
      default:
        return "Sorry, that one's gone too far through the kitchen for me to add to it.";
    }
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

  /**
   * "Same as last time?" — the whole order, in one sentence, answered with one
   * word.
   *
   * Resolved against TODAY's menu, not repeated from the old ticket. A shop
   * changes its prices, renames things and runs out; offering food it no
   * longer sells, at last month's price, is worse than not offering at all.
   * Anything that cannot be found now is simply left out and said aloud, so
   * the caller hears exactly what they are agreeing to.
   */
  /**
   * Last time's order, resolved against today's menu. Changes nothing.
   *
   * Both engines need this and they need it at different moments: the chained
   * one offers it and loads the basket in one go, while the speech-to-speech
   * one has to describe it in its instructions BEFORE the caller has said yes,
   * and load it only when they do.
   */
  resolveUsual(
    ctx: VoiceContext,
    last: {
      items: Array<{
        menuItemId?: string | null;
        name: string;
        quantity: number;
        notes?: string | null;
      }>;
    },
  ): {
    lines: Array<{ item: any; quantity: number; notes?: string | null }>;
    gone: string[];
  } | null {
    const lines: Array<{ item: any; quantity: number; notes?: string | null }> = [];
    const gone: string[] = [];

    for (const it of last.items) {
      // By id first — a rename should not lose the line — then by name, which
      // is how an order taken on the till or the website will match.
      const byId = it.menuItemId ? ctx.itemIndex.get(String(it.menuItemId)) : undefined;
      const matched =
        byId ??
        (() => {
          const m = matchItemGroups(String(it.name ?? ''), ctx.items, { limit: 2, floor: 0.6 });
          if (!isConfidentGroup(m)) return undefined;
          const g = m[0]!.group;
          return g.variants.length === 1 ? g.variants[0] : pickVariant(String(it.name), g.variants);
        })();
      if (!matched) {
        gone.push(String(it.name ?? '').trim());
        continue;
      }
      lines.push({
        item: matched,
        quantity: Math.max(1, Math.round(Number(it.quantity) || 1)),
        notes: it.notes ?? null,
      });
    }

    // One item off a two-item order is not "the usual" any more, and reading a
    // half-order back invites a yes to something they did not have.
    if (!lines.length || gone.length > lines.length) return null;
    return { lines, gone };
  }

  /** Put a resolved usual into the basket. */
  loadUsual(
    state: VoiceState,
    resolved: { lines: Array<{ item: any; quantity: number; notes?: string | null }> },
    last: { fulfillmentType: string; deliveryAddress?: any },
  ): void {
    const lines = resolved.lines;
    state.cart.items = lines.map((l) => ({
      lineId: Math.random().toString(36).slice(2, 9),
      itemId: l.item.id,
      name: l.item.name,
      quantity: l.quantity,
      unitBasePrice: l.item.price,
      modifiers: [],
      ...(l.notes ? { notes: l.notes } : {}),
    })) as any;
    state.cart.fulfillmentType = last.fulfillmentType === 'DELIVERY' ? 'DELIVERY' : 'PICKUP';
    state.cart.fulfillmentChosen = true;
    if (state.cart.fulfillmentType === 'DELIVERY' && last.deliveryAddress) {
      state.cart.deliveryAddress = last.deliveryAddress;
    }
  }

  /** How the usual is said aloud, given what resolved. */
  usualSpoken(
    resolved: { lines: Array<{ item: any; quantity: number }>; gone: string[] },
    fulfillmentType: string,
    addressLine1?: string | null,
  ): string {
    const lines = resolved.lines;
    const gone = resolved.gone;
    const spoken = this.listAloud(
      lines.map(({ item, quantity }) => this.spokenLine(item.name, quantity)),
    );
    const where =
      fulfillmentType === 'DELIVERY'
        ? addressLine1
          ? `, delivered to ${addressLine1}`
          : ', for delivery'
        : ', for collection';
    const missing = gone.length
      ? ` We're not doing ${this.listAloud(gone)} any more, so that's off.`
      : '';

    return `Would you like the same as last time — ${spoken}${where}?${missing}`;
  }

  usualAloud(
    ctx: VoiceContext,
    state: VoiceState,
    last: {
      fulfillmentType: string;
      items: Array<{
        menuItemId?: string | null;
        name: string;
        quantity: number;
        notes?: string | null;
      }>;
      deliveryAddress?: any;
    },
  ): { say: string; next: VoiceState['awaiting'] } | null {
    const resolved = this.resolveUsual(ctx, last);
    if (!resolved) return null;
    this.loadUsual(state, resolved, last);
    return {
      say: this.usualSpoken(
        resolved,
        state.cart.fulfillmentType ?? 'PICKUP',
        state.cart.deliveryAddress?.line1,
      ),
      next: 'USUAL',
    };
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
    // The yes was parsed by the slot machine before this ran — that is the
    // only way in here — so it is handed to the tool as the consent it is.
    await this.runTool(
      'confirm_delivery_address',
      { __heard: 'yes', __heardFresh: true, __heardReadable: true },
      ctx,
      state,
      null,
    );
    if (!state.addressConfirmed) {
      // Outside the delivery area. Say so — but never leave them with nowhere
      // to go, because "we don't deliver there" with no follow-up is where a
      // caller hangs up and orders from someone else.
      return "I'm sorry, we don't deliver that far. I can do it for collection instead, or if there's another address you'd like it sent to, just say.";
    }
    const fee = this.feeForAddress(state.cart.deliveryAddress, ctx);
    const feeLine = fee > 0 ? ` Delivery is ${money(fee, ctx.currency)}.` : '';
    return `Great.${feeLine} What would you like to order?`;
  }

  /** The caller agreed to the order we read back. */
  confirmOrderAloud(state: VoiceState): string {
    state.orderConfirmed = true;
    return 'How would you like to pay — cash, or card?';
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
    choice: 'DELIVERY' | 'PICKUP',
  ): { say: string; next?: VoiceState['awaiting'] } {
    state.cart.fulfillmentType = choice;
    state.cart.fulfillmentChosen = true;

    if (choice === 'PICKUP') {
      state.cart.deliveryAddress = undefined;
      state.addressConfirmed = false;
      return { say: 'Lovely, collection it is. What would you like to order?' };
    }

    // A regular gets one yes instead of reciting where they live.
    const saved = state.savedAddress;
    if (saved?.line1) {
      return {
        say: `Are you still at ${saved.line1}?`,
        next: 'ADDRESS_CONFIRM',
      };
    }
    // One question. Most callers answer all of it in one breath — "eleven
    // Sunningdale Drive, Washington" — and making them spell a postcode first
    // to arrive at what they already said is three turns of nobody's time.
    //
    // The postcode ladder underneath is not gone; it is what happens when this
    // doesn't land. See addressAloud.
    return postcodeRequiredFor(ctx.country)
      ? { say: "No problem. What's the delivery address?", next: 'ADDR_FULL' }
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
    method: 'CASH' | 'CARD',
    callerNumber?: string | null,
  ): Promise<{ say: string; turn?: Partial<VoiceTurn>; next?: VoiceState['awaiting'] }> {
    // We need a name on the ticket, and asking for it is one short turn — far
    // better than the kitchen getting "Phone order".
    if (!state.knownName) {
      state.pendingPayment = method;
      return { say: 'And can I take your name?', next: 'NAME' };
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
    const method = state.pendingPayment === 'CARD' ? 'CARD' : 'CASH';
    return this.placeAloud(ctx, state, method, name, callerNumber);
  }

  private async placeAloud(
    ctx: VoiceContext,
    state: VoiceState,
    method: 'CASH' | 'CARD',
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
      return { say: '', turn: out.turn };
    }

    const mins =
      state.cart.fulfillmentType === 'DELIVERY'
        ? ctx.deliveryPrepMinutes
        : ctx.collectionPrepMinutes;
    const where = state.cart.fulfillmentType === 'DELIVERY' ? 'with you' : 'ready';
    const card =
      method === 'CARD' ? " I've sent you a payment link — you can pay on your phone." : '';
    return {
      say: `That's all booked in. It'll be about ${mins} minutes ${where}.${card} Thanks for calling, goodbye.`,
      turn: { ...out.turn, endCall: true },
    };
  }

  /**
   * The whole address, taken in one breath.
   *
   * A caller saying "eleven Sunningdale Drive, Washington" has already given
   * the postcode question, the street question and the house-number question
   * their answers; asking all three anyway is a machine making a person do its
   * filing. So this sends what they said to a geocoder and reads the WHOLE
   * address back — postcode included, which is the part they didn't say and
   * the part the driver needs.
   *
   * When it doesn't land, nothing is lost: we drop into the postcode ladder,
   * which is slower but nearly unbreakable. That is the order these belong in.
   * Never the other way round, and never give up on the caller.
   */
  async addressAloud(
    ctx: VoiceContext,
    state: VoiceState,
    said: string,
    resolve: (query: string) => Promise<AddressCandidate[]>,
  ): Promise<{ say: string; next: VoiceState['awaiting'] }> {
    // A postcode is a UNIQUE key. A street name is not — there is a
    // Sunningdale Drive in Salford, Belfast, Bristol and Washington, and a
    // free-text search asked for one returns whichever is most famous. So
    // whenever the caller has given a postcode, the postcode decides where
    // they are and the search engine is never consulted about it at all.
    // Free-text is for the callers who didn't give one.
    const pinned =
      findPostcodeIn(
        said,
        ctx.deliveryZones.map((z) => z.postcodePrefix),
      ) ??
      state.addr?.postcode ??
      null;

    const rest = stripPostcode(said);
    const spokenLine = addressLineFrom(rest);
    const spokenStreet = streetOf(spokenLine);
    const house =
      spokenLine && spokenStreet && spokenLine.endsWith(spokenStreet)
        ? spokenLine
            .slice(0, spokenLine.length - spokenStreet.length)
            .trim()
            .replace(/,$/, '')
            .trim() || null
        : null;

    if (pinned) {
      // Out of the shop's part of the country entirely. Reading it back at all
      // is how a Washington caller was told Salford; the honest answer is that
      // we don't deliver there.
      const areas = shopAreas(ctx);
      if (areas.size && !areas.has(postcodeArea(pinned))) {
        state.confusion = 0;
        return {
          say: `Sorry — ${pinned} is outside our delivery area. Would you like to collect instead, or is there another address we could deliver to?`,
          next: 'ADDR_FULL',
        };
      }

      const [known, town] = await Promise.all([
        this.streetsForPostcodeSafely(ctx, pinned),
        this.townForPostcodeSafely(pinned),
      ]);
      const streets = uniqueStreets(known);
      const chosen = spokenStreet
        ? matchStreet(spokenStreet, streets)
        : streets.length === 1
          ? streets[0]!
          : null;

      if (chosen) {
        // The town comes from the POSTCODE. Not from the shop's own record,
        // not from what somebody typed at a till. If the postcode cannot tell
        // us, we say the street and the postcode and no town at all — that is
        // correct, and borrowing one to fill the gap is what caused this.
        const city = town ?? undefined;
        state.confusion = 0;
        state.addr = { postcode: pinned, street: chosen, city };
        if (!house) {
          // Everything but the number, which is the one thing neither the
          // postcode nor the search can ever know.
          return {
            say: `Thanks — ${chosen}, ${city ?? ''}. And the house number or name?`.replace(
              /, \./,
              '.',
            ),
            next: 'ADDR_HOUSE',
          };
        }
        state.cart.deliveryAddress = {
          line1: `${house} ${chosen}`,
          city: city ?? '',
          postcode: pinned,
          country: ctx.country,
        } as any;
        return {
          say: `Thanks. That's ${this.spokenAddress(state.cart.deliveryAddress as any)} — is that right?`,
          next: 'ADDRESS_CONFIRM',
        };
      }

      // We have the postcode but not the street — either nothing came back for
      // it, or what they said doesn't match anything in it. The ladder's own
      // street step handles both, and it must not ask for the postcode again.
      state.addr = { ...(state.addr ?? {}), postcode: pinned, house: house ?? undefined };
      if (streets.length) {
        state.addr.street = streets[0]!;
        state.addr.city = town ?? undefined;
        return {
          say: `Thanks. That's ${streets[0]}${state.addr.city ? `, ${state.addr.city}` : ''} — is that right?`,
          next: 'ADDR_STREET',
        };
      }
      return { say: "Thanks. And what's the street name and house number?", next: 'ADDR_HOUSE' };
    }

    // No postcode anywhere in it, so this is a genuine free-text lookup —
    // fenced to the shop's own part of the country by rankAddresses.
    let found: AddressCandidate[] = [];
    try {
      found = await Promise.race([
        resolve(addressQuery(said, ctx, null)),
        new Promise<AddressCandidate[]>((r) => setTimeout(() => r([]), LOOKUP_TIMEOUT_MS)),
      ]);
    } catch {
      found = [];
    }

    const best = bestAddress(rankAddresses(said, found, ctx, null));
    if (!best) {
      const misses = (state.confusion ?? 0) + 1;
      state.confusion = misses;
      return misses < 2
        ? { say: "Sorry, I didn't get that. What's your postcode?", next: 'ADDR_POSTCODE' }
        : {
            say: "Let's try it differently — what's the street name and house number?",
            next: 'ADDR_HOUSE',
          };
    }

    state.confusion = 0;
    state.addr = {
      postcode: best.postcode,
      street: streetOf(best.line1) ?? undefined,
      city: best.city,
    };
    state.cart.deliveryAddress = {
      line1: best.line1,
      city: best.city ?? '',
      postcode: best.postcode,
      country: ctx.country,
    } as any;
    return {
      say: `Thanks. That's ${this.spokenAddress(state.cart.deliveryAddress as any)} — is that right?`,
      next: 'ADDRESS_CONFIRM',
    };
  }

  /** The post town, bounded and never throwing — it runs mid-call. */
  private async townForPostcodeSafely(postcode: string): Promise<string | null> {
    try {
      return await Promise.race([
        this.addresses.townForPostcode(postcode),
        new Promise<string | null>((r) => setTimeout(() => r(null), LOOKUP_TIMEOUT_MS)),
      ]);
    } catch {
      return null;
    }
  }

  /** streetsForPostcode, bounded and never throwing — it runs mid-call. */
  private async streetsForPostcodeSafely(
    ctx: VoiceContext,
    postcode: string,
  ): Promise<Array<{ line1?: string; city?: string }>> {
    try {
      return await Promise.race([
        this.streetsForPostcode(ctx, postcode),
        new Promise<Array<{ line1?: string; city?: string }>>((r) =>
          setTimeout(() => r([]), LOOKUP_TIMEOUT_MS),
        ),
      ]);
    } catch {
      return [];
    }
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
  ): Promise<{ say: string; next?: VoiceState['awaiting'] }> {
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
            next: 'ADDR_POSTCODE',
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
    // The town comes from the POSTCODE, never from the shop's own record. A
    // shop delivers to more than one town, so its own city is a guess — and a
    // guess that reads back as fact is how a Washington caller heard Salford.
    const city = (await this.townForPostcodeSafely(postcode)) ?? withStreet?.city ?? undefined;
    if (!street) {
      return {
        say: `Thanks. And what's the street?`,
        next: 'ADDR_HOUSE',
      };
    }

    state.addr.street = street;
    state.addr.city = city;
    return {
      say: `Thanks. That's ${street}${city ? `, ${city}` : ''} — is that right?`,
      next: 'ADDR_STREET',
    };
  }

  /**
   * Postcode → street names, our own deliveries first.
   *
   * Every external lookup so far has been a bet on somebody else's uptime, and
   * on a phone call we lose that bet in silence. But a takeaway has already
   * driven to this postcode: the streets it delivers to are sitting in its own
   * order history, they cost one indexed query, they cannot go down, and they
   * get better every week the shop trades. So we ask ourselves first and only
   * go out to the network for a postcode we've genuinely never seen.
   */
  async streetsForPostcode(
    ctx: VoiceContext,
    postcode: string,
  ): Promise<Array<{ line1?: string; city?: string }>> {
    // Compact FIRST. "NE10 8HF" sliced as-is becomes "NE10  8HF" — a double
    // space that reached the logs and would have reached a receipt.
    const compact = postcode.replace(/\s+/g, '');
    const pretty = `${compact.slice(0, -3)} ${compact.slice(-3)}`;
    try {
      const rows = await this.prisma.order.findMany({
        where: {
          tenantId: (ctx as any).tenantId,
          OR: [
            { postcode: { equals: pretty, mode: 'insensitive' } },
            { postcode: { equals: postcode, mode: 'insensitive' } },
          ],
          addressLine1: { not: null },
          // Never learn from ourselves. A caller said "Sunningdale Drive", an
          // earlier call wrote it down as "Sunnydale Drive", and this query
          // then read that back to the next caller as fact — with more
          // confidence than the geocoders, which had it right all along. Only
          // addresses a HUMAN typed (POS, storefront, marketplace) are
          // evidence; ours are just a recording of our own mistakes.
          orderSource: { not: 'VOICE' },
        },
        select: { addressLine1: true, city: true },
        orderBy: { receivedAt: 'desc' },
        take: 25,
      });
      // Rank by how often we've actually delivered there — on a postcode that
      // straddles two streets, the one we know best is the better guess.
      const tally = new Map<string, { street: string; city?: string; n: number }>();
      for (const row of rows) {
        const street = streetOf(row.addressLine1);
        if (!street) continue;
        const k = street.toLowerCase();
        const hit = tally.get(k);
        if (hit) hit.n += 1;
        else tally.set(k, { street, city: row.city ?? undefined, n: 1 });
      }
      const known = [...tally.values()].sort((a, b) => b.n - a.n);
      if (known.length) {
        this.logger?.log(`streets for ${pretty} from our own orders: ${known.length}`);
        // Streets only. The CITY on these rows is whatever somebody typed at a
        // till, and one wrong entry told a caller in Washington they were in
        // Salford — in 52ms, because the answer never left the building. The
        // town comes from the postcode and nowhere else.
        return known.map((k) => ({ line1: k.street }));
      }
    } catch (err: any) {
      // Our own history is an optimisation, never a dependency. If the query
      // is unhappy we still have the provider chain below, and the caller
      // must not hear the difference.
      this.logger?.warn(`own-orders street lookup failed: ${err?.message ?? err}`);
    }

    const res: any = await this.addresses.searchByPostcode(postcode);
    this.logger?.log(
      `streets for ${pretty} from ${res?.provider ?? '?'}: ${res?.suggestions?.length ?? 0}`,
    );
    return (res?.suggestions ?? []).map((sg: any) => ({ line1: sg.line1 }));
  }

  /**
   * The same postcode lookup the scripted flow uses, exposed to the model.
   *
   * The model only drives an address when the scripted path has already been
   * knocked off course, and that is exactly when it must not fall back to
   * asking for the whole thing in one breath. Giving it the lookup means the
   * worst case still follows the same shape as the best case.
   */
  /** resolve_address, for when the scripted path has been knocked sideways. */
  private async resolveAddressTool(
    said: string,
    ctx: VoiceContext,
    state: VoiceState,
  ): Promise<string> {
    const pinned =
      findPostcodeIn(
        said,
        ctx.deliveryZones.map((z) => z.postcodePrefix),
      ) ??
      state.addr?.postcode ??
      null;

    let found: AddressCandidate[] = [];
    try {
      found = await Promise.race([
        this.addresses
          .resolveAddress(addressQuery(said, ctx, pinned), { country: ctx.country })
          .then((rows) =>
            rows.map((r: any) => ({ line1: r.line1, city: r.city, postcode: r.postcode })),
          ),
        new Promise<AddressCandidate[]>((r) => setTimeout(() => r([]), LOOKUP_TIMEOUT_MS)),
      ]);
    } catch {
      found = [];
    }

    const best = bestAddress(rankAddresses(said, found, ctx, pinned));
    if (!best) {
      return "Could not resolve that into a real address. Ask for the postcode on its own and use lookup_postcode. Do NOT tell them you can't take their address.";
    }
    state.addr = {
      postcode: best.postcode,
      street: streetOf(best.line1) ?? undefined,
      city: best.city,
    };
    state.cart.deliveryAddress = {
      line1: best.line1,
      city: best.city ?? '',
      postcode: best.postcode,
      country: ctx.country,
    } as any;
    return `That resolves to ${this.spokenAddress(state.cart.deliveryAddress as any)}. Say exactly that followed by "— is that right?" and wait. If they say yes, call confirm_delivery_address.`;
  }

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
        this.streetsForPostcode(ctx, postcode),
        new Promise<Array<{ line1?: string; city?: string }>>((resolve) =>
          setTimeout(() => resolve([]), LOOKUP_TIMEOUT_MS),
        ),
      ]);
    } catch {
      found = [];
    }

    const withStreet = found.find((f) => streetOf(f.line1));
    const street = streetOf(withStreet?.line1) ?? null;
    const city = (await this.townForPostcodeSafely(postcode)) ?? withStreet?.city ?? undefined;
    if (!street) {
      return `Postcode ${postcode} is noted, but no street came back for it. Ask them for the street name and house number together — do NOT ask for the postcode again.`;
    }
    state.addr.street = street;
    state.addr.city = city;
    return `Postcode ${postcode} is ${street}${city ? `, ${city}` : ''}. Say "That's ${street}${city ? `, ${city}` : ''} — is that right?" and wait. If they say yes, ask only for the house number or name.`;
  }

  /** They confirmed the street. Only the number is left — unless they already
   *  gave it, which is what "five signing their drive" was. */
  streetAgreedAloud(
    ctx?: VoiceContext,
    state?: VoiceState,
  ): { say: string; next: VoiceState['awaiting'] } {
    const house = state?.addr?.house;
    if (ctx && state && house && state.addr?.street) {
      return this.houseNumberAloud(ctx, state, house);
    }
    return { say: 'Great. And the house number or name?', next: 'ADDR_HOUSE' };
  }

  /**
   * The looked-up street was wrong.
   *
   * Asking for the postcode again would be asking for the thing they already
   * got right. They know their own street; the database evidently does not, so
   * this hands the question back to them — street and number together, because
   * that is how anyone says it.
   */
  streetRejectedAloud(state: VoiceState): { say: string; next: VoiceState['awaiting'] } {
    if (state.addr) state.addr.street = undefined;
    return {
      say: "Sorry about that. What's the street name and house number?",
      next: 'ADDR_HOUSE',
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
  ): { say: string; next: VoiceState['awaiting'] } {
    const street = state.addr?.street;
    // With a street already agreed, all that is wanted is the number. Without
    // one — the lookup found nothing, or the caller said it was wrong — they
    // are giving the whole line, and "11 Fellside Road" has to survive intact.
    // If they named a street while giving the number, that is the street.
    // This used to take only the digits out of "Eleven Sunningdale Drive" and
    // staple our own guess back on, which is the exact moment a wrong street
    // became permanent — the caller had just said the right one out loud.
    const spokenLine = addressLineFrom(said);
    const spokenStreet = streetOf(spokenLine);
    // Only when they said a NUMBER and a street. "Rose Cottage" is a house
    // name, not a correction, and treating it as one produced the immortal
    // "Rose Cottage Rose Cottage".
    const namedBoth =
      !!spokenLine &&
      !!spokenStreet &&
      spokenStreet !== spokenLine &&
      looksLikeStreet(spokenStreet);
    if (namedBoth && street && spokenStreet && !sameStreet(spokenStreet, street)) {
      state.addr!.street = spokenStreet;
    }
    const agreedStreet = state.addr?.street;

    const line1 = agreedStreet
      ? (() => {
          const house = houseNumberFrom(said);
          return house ? `${house} ${agreedStreet}` : null;
        })()
      : (spokenLine ?? houseNumberFrom(said));

    // A street with no number in front of it is not somewhere a driver can go.
    // Asked for "the street name and house number", a caller who says only
    // "Sunningdale Drive" was having that confirmed back to them as a whole
    // address — and a confident read-back is exactly what stops them noticing.
    if (!agreedStreet && line1 && hasStreetType(line1) && streetOf(line1) === line1) {
      state.addr = { ...(state.addr ?? {}), street: line1 };
      return { say: 'Thanks. And the house number or name?', next: 'ADDR_HOUSE' };
    }

    if (!line1) {
      return {
        say: street
          ? 'Sorry, what was the house number or name?'
          : "Sorry, what's the street name and house number?",
        next: 'ADDR_HOUSE',
      };
    }

    state.cart.fulfillmentType = 'DELIVERY';
    state.cart.fulfillmentChosen = true;
    state.cart.deliveryAddress = {
      line1,
      // No town rather than the shop's town. "5 Sunningdale Drive, NE37 2LL"
      // is a correct address; "5 Sunningdale Drive, Salford, NE37 2LL" is a
      // wrong one, and only the second sounds confident.
      city: state.addr?.city ?? '',
      postcode: state.addr?.postcode,
      country: ctx.country,
    };
    state.addressConfirmed = false;

    return {
      say: `So that's ${this.spokenAddress(state.cart.deliveryAddress)}. Is that correct?`,
      next: 'ADDRESS_CONFIRM',
    };
  }

  /** They said no to a read-back. */
  rejectedReadBack(what: 'ADDRESS_CONFIRM' | 'ORDER_CONFIRM'): {
    say: string;
    next?: VoiceState['awaiting'];
  } {
    // Asking for a postcode here made a caller who had just said their whole
    // address say a different, smaller part of it. Ask for the same thing
    // again — and if the second attempt misses too, addressAloud's own count
    // drops into the postcode ladder without anybody having to decide to.
    return what === 'ADDRESS_CONFIRM'
      ? { say: "Sorry about that. What's the delivery address?", next: 'ADDR_FULL' }
      : { say: 'No problem. What would you like to change?' };
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
    state.turns.push({ role: 'user', text: args.userText });

    if (!this.anthropic) {
      const say = "Sorry, I can't take your order right now. Let me put you through to the shop.";
      state.turns.push({ role: 'assistant', text: say });
      return {
        turn: { say, transferTo: ctx.transferNumber ?? undefined, outcome: 'TRANSFERRED' },
        state,
      };
    }

    let turn: VoiceTurn = { say: '' };

    try {
      const messages: Anthropic.MessageParam[] = state.turns.map((t) => ({
        role: t.role === 'user' ? 'user' : 'assistant',
        content: t.text,
      }));

      const system: Anthropic.TextBlockParam[] = [
        {
          type: 'text',
          text: this.systemPrompt(ctx, state),
          // The menu is re-sent on every turn of every call and is identical
          // across them. Caching it is the single biggest lever on our cost
          // per call — without it the Claude bill roughly triples.
          cache_control: { type: 'ephemeral' },
        },
        { type: 'text', text: `=== ORDER SO FAR ===\n${summarizeCart(state.cart, ctx.currency)}` },
      ];

      const tools = this.toolDefs(ctx);
      let spoken = '';

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
          .filter((b): b is Anthropic.TextBlock => b.type === 'text')
          .map((b) => b.text)
          .join(' ')
          .trim();
        // Accumulated, not replaced. A turn that says "let me just add that",
        // calls a tool, then says "done, anything else?" spoke BOTH out loud —
        // recording only the second leaves the transcript disagreeing with
        // what the caller actually heard.
        if (text) spoken = spoken ? `${spoken} ${text}` : text;

        const toolUses = response.content.filter(
          (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use',
        );
        if (response.stop_reason !== 'tool_use' || toolUses.length === 0) break;

        messages.push({ role: 'assistant', content: response.content });
        const results: Anthropic.ToolResultBlockParam[] = [];
        let direct: string | undefined;
        for (const tu of toolUses) {
          const out = await this.runTool(tu.name, tu.input as any, ctx, state, args.callerNumber);
          if (out.turn) turn = { ...turn, ...out.turn };
          if (out.sayNow) direct = out.sayNow;
          results.push({ type: 'tool_result', tool_use_id: tu.id, content: out.result });
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
        messages.push({ role: 'user', content: results });
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
        outcome: 'TRANSFERRED',
      };
    }

    if (!turn.say) {
      turn.say = 'Sorry, could you say that again?';
    }
    state.turns.push({ role: 'assistant', text: turn.say });
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

    let buffer = '';
    let inText = false;
    stream.on('contentBlock', () => {
      // Flush whatever is left of a text block when it ends.
      if (inText && buffer.trim()) {
        onPartial(this.speakable(buffer));
        markStreamed();
        buffer = '';
      }
      inText = false;
    });
    stream.on('streamEvent', (event) => {
      if (event.type === 'content_block_start') {
        inText = event.content_block.type === 'text';
        return;
      }
      if (!inText || event.type !== 'content_block_delta' || event.delta.type !== 'text_delta') {
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
      .replace(/[*_`#]+/g, '')
      .replace(/^\s*[-•]\s*/gm, '')
      .replace(/\s*\n+\s*/g, ' ')
      .replace(/\s{2,}/g, ' ')
      .trim();
  }

  // ── System prompt ───────────────────────────────────────────────────────

  private systemPrompt(
    ctx: VoiceContext,
    state?: VoiceState,
    opts: { menu?: 'full' | 'brief' } = {},
  ): string {
    // The speech-to-speech API caps instructions at 16,384 tokens. This shop's
    // menu alone is 69,319 — 150 items with every option spelled out — so the
    // session was rejected outright on every single call since the engine was
    // built, and the caller sat through five seconds of silence before being
    // handed to the chained engine. It was never a connection problem.
    //
    // The model does not need the menu inlined. find_item and add_item match
    // the caller's own words against the whole thing server-side and hand back
    // exactly one dish — which is both smaller and more accurate than asking a
    // model to pick an id out of a wall of text.
    if (opts.menu === 'brief') return this.briefPrompt(ctx, state);
    const menu = ctx.items
      .map((it) => {
        const mods = it.modifierGroups
          .map((g) => {
            const opts = g.options
              .map(
                (o) => `${o.name}${o.price ? ` +${money(o.price, ctx.currency)}` : ''} [${o.id}]`,
              )
              .join(', ');
            // The model is told the same thing the code enforces. A menu that
            // says isRequired=false and minSelections=1 means "pick one", and
            // describing that as optional invited the model to skip it.
            const rule = mustChoose(g)
              ? `REQUIRED pick ${needed(g)}${g.max ? `-${g.max}` : '+'}`
              : `optional`;
            return `    - ${g.name} (${rule}): ${opts}`;
          })
          .join('\n');
        return `  ${it.name} — ${money(it.price, ctx.currency)} [${it.id}]${
          it.description ? ` — ${it.description}` : ''
        }${mods ? `\n${mods}` : ''}`;
      })
      .join('\n');

    // What locates a caller depends on the shop. Asking a Dubai caller for a
    // postcode gets you silence: there isn't one. Where the shop prices by
    // area, the areas are named here so the model asks for one of THEM rather
    // than inventing a plausible neighbourhood.
    const areas = areaZoneNames(ctx.deliveryZones as any);
    const deliveryGuidance = areas.length
      ? `- This shop delivers by AREA, not postcode. The areas are: ${areas.join(', ')}. Ask which one they are in, run check_delivery_area with it, and pass it to set_fulfillment as \`area\`. Never accept an area that is not on that list — say plainly that the shop does not deliver there and offer collection.`
      : postcodeRequiredFor(ctx.country)
        ? '- For delivery, get the postcode first and run check_delivery_area before taking the rest of the address. Do not take a full address for an area the shop does not deliver to.'
        : '- Addresses here do NOT have postcodes. Never ask for one — take the building or street and the city.';

    // Caller ID turns the worst part of a phone order — reciting an address to
    // a machine — into one yes. Only offered, never assumed: people move, and
    // people order to their mum's.
    const saved = state?.savedAddress;
    const savedGuidance = saved?.line1
      ? `\nTHIS CALLER HAS ORDERED BEFORE\nTheir name is ${state?.knownName ?? 'not recorded'} and their last delivery address was ${[saved.line1, saved.city, saved.postcode].filter(Boolean).join(', ')}.\n- If they want delivery, do NOT ask for the address from scratch. Ask "Are you still at ${saved.line1}?" and wait.\n- If yes: call use_saved_address. It is already confirmed — you do not need to read it back again.\n- If no: take a new address the normal way, with the read-back.\n- Do not use their name more than twice in the call. More than that is unsettling, not friendly.`
      : '';

    // A line that cheerfully takes an order from a closed shop is worse than
    // one that doesn't answer: the customer waits for food nobody is cooking.
    const open = ctx.openingHours
      ? isCurrentlyOpen(ctx.openingHours, ctx.timezone || 'Europe/London')
      : true;
    const closedGuidance = open
      ? ''
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

DELIVERY ADDRESSES — ASK ONCE, THEN FALL BACK
Ask for the whole address in ONE question: "What's the delivery address?" Most people answer all of it in one breath, and making them spell a postcode first to arrive at what they just said is a machine giving a person filing to do.
1. Call resolve_address with exactly what they said. It geocodes the sentence and comes back with the full address INCLUDING the postcode — which is the part they didn't say and the driver needs.
2. It hands you the address to read back. Say exactly that and wait for a yes.
3. If it says it could not resolve it, drop to the postcode ladder — it is slower but it nearly always works, and it is why you must never tell a caller you can't take their address:
   a. "What's your postcode?" — that alone, then call lookup_postcode with what they said.
   b. It gives you the street. Say "That's <street>, <town> — is that right?" and wait.
   c. Yes: "And the house number or name?" No: "What's the street name and house number?" — they know their street, the database evidently does not. NEVER ask for the postcode a second time.
   d. Call propose_delivery_address with the house number, street and postcode, and read back what it gives you.
4. Only once they have said yes to a read-back, call confirm_delivery_address. That is what sets the delivery charge, and place_order refuses until you have.
Never argue with a caller about their own address, and never end a call because an address would not resolve.
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

LANGUAGE
- Speak ${ctx.spokenLanguage ?? 'English'}, and only ${ctx.spokenLanguage ?? 'English'} — every word,
  for the whole call, whatever language or accent the caller uses. If they
  speak another language, reply in ${ctx.spokenLanguage ?? 'English'} anyway. Never switch.

MENU
${menu || '(no items available — apologise and transfer)'}`;
  }

  // ── Tools ───────────────────────────────────────────────────────────────

  private toolDefs(ctx: VoiceContext): Anthropic.Tool[] {
    return [
      {
        name: 'find_item',
        description:
          "Check what a caller meant before adding it. Use whenever what you heard doesn't obviously match one dish — the transcription is often wrong about food names. Returns the closest menu items.",
        input_schema: {
          type: 'object',
          properties: {
            said: { type: 'string', description: 'What the caller said, as you heard it' },
          },
          required: ['said'],
        },
      },
      {
        name: 'use_usual',
        description:
          'The caller said yes to having the same as last time. Puts that whole order — items, collection or delivery, and the address — into the basket. Only call this after they have agreed to the exact order you read out. Follow it with read_back_order.',
        input_schema: { type: 'object', properties: {} },
      },
      {
        name: 'add_item',
        description:
          "Add one menu item to the order. Pass `said` with the caller's own words and it will be matched against the menu — you do not need the exact id, and matching handles mis-heard names. Ask for any REQUIRED option group before calling this. Callers list several things at once; call this once per item in the SAME turn rather than asking after each one.",
        input_schema: {
          type: 'object',
          properties: {
            said: {
              type: 'string',
              description:
                "The caller's own words for this one item, including any quantity — e.g. 'three cola', 'large pepperoni'. Preferred over itemId.",
            },
            itemId: {
              type: 'string',
              description: 'Exact item id from the menu, if you are sure of it',
            },
            quantity: { type: 'integer', minimum: 1, default: 1 },
            modifierOptionIds: {
              type: 'array',
              items: { type: 'string' },
              description: 'Chosen option ids, exactly as listed in the menu',
            },
            notes: { type: 'string', description: 'e.g. no onions' },
          },
        },
      },
      {
        name: 'remove_item',
        description: 'Remove a line the caller changed their mind about.',
        input_schema: {
          type: 'object',
          properties: { lineId: { type: 'string' } },
          required: ['lineId'],
        },
      },
      {
        name: 'set_fulfillment',
        description:
          'Record whether this is collection or delivery. Call it as soon as they tell you. For delivery the address is taken separately, with propose_delivery_address.',
        input_schema: {
          type: 'object',
          properties: {
            type: { type: 'string', enum: ['DELIVERY', 'PICKUP'] },
          },
          required: ['type'],
        },
      },
      {
        name: 'resolve_address',
        description:
          'Turn a whole spoken address into a real one with a postcode. Pass exactly what the caller said. Use this FIRST for any delivery address; only fall back to lookup_postcode if this says it could not resolve it.',
        input_schema: {
          type: 'object',
          properties: {
            said: { type: 'string', description: "The caller's own words, verbatim." },
          },
          required: ['said'],
        },
      },
      {
        name: 'lookup_postcode',
        description:
          'Turn a postcode into a street. ALWAYS use this before taking a delivery address — never ask the caller to say their street. Pass whatever they said, even a whole address; the postcode is found inside it.',
        input_schema: {
          type: 'object',
          properties: {
            said: {
              type: 'string',
              description: 'What the caller said when asked for their postcode',
            },
          },
          required: ['said'],
        },
      },
      {
        name: 'propose_delivery_address',
        description:
          'The address you just heard, before you have read it back. Returns the exact words to say to the caller. Say them, then wait for a yes.',
        input_schema: {
          type: 'object',
          properties: {
            line1: { type: 'string', description: 'House number and street' },
            city: { type: 'string' },
            postcode: { type: 'string' },
            area: {
              type: 'string',
              description:
                'The named community, e.g. Dubai Marina. Use instead of postcode where the shop delivers by area.',
            },
          },
          required: ['line1'],
        },
      },
      {
        name: 'confirm_delivery_address',
        description:
          'The caller has heard the address read back and said it is right. ONLY call this after they have confirmed out loud. This sets the delivery charge.',
        input_schema: { type: 'object', properties: {} },
      },
      {
        name: 'use_saved_address',
        description:
          'The caller confirmed they are still at the address we already have on file for them. Only available when the call notes give you one.',
        input_schema: { type: 'object', properties: {} },
      },
      {
        name: 'read_back_order',
        description:
          'Get the exact words to read the whole order back. Say them, then wait for a yes. place_order will refuse until they have confirmed.',
        input_schema: { type: 'object', properties: {} },
      },
      {
        name: 'order_confirmed',
        description:
          'The caller has heard the whole order read back and said yes. Only call this after they have confirmed out loud.',
        input_schema: { type: 'object', properties: {} },
      },
      {
        name: 'check_delivery_area',
        description:
          'Check whether the shop delivers somewhere, and what the fee is. Always call this before taking a full delivery address. Pass `area` where the shop delivers by area, `postcode` otherwise.',
        input_schema: {
          type: 'object',
          properties: {
            postcode: { type: 'string' },
            area: { type: 'string', description: 'The named community, e.g. Dubai Marina' },
          },
        },
      },
      {
        name: 'get_opening_hours',
        description: "The shop's opening hours, for 'what time do you close' questions.",
        input_schema: { type: 'object', properties: {} },
      },
      {
        name: 'get_order_status',
        description:
          "Look up this caller's most recent order — for 'where is my food' questions. Uses the number they are calling from.",
        input_schema: {
          type: 'object',
          properties: {
            orderNumber: { type: 'string', description: 'Only if they read one out' },
          },
        },
      },
      {
        name: 'amend_order',
        description:
          'Add the items now on the order to an order the caller placed earlier. Only available while changing an existing order. Read the WHOLE order back and get a yes first, exactly as you would before placing one.',
        input_schema: { type: 'object', properties: {} },
      },
      {
        name: 'place_order',
        description:
          'Place the order. Only after order_confirmed, and after asking how they want to pay.',
        input_schema: {
          type: 'object',
          properties: {
            customerName: { type: 'string' },
            paymentMethod: {
              type: 'string',
              enum: ['CASH', 'CARD'],
              description:
                'CASH = pay at the shop or on delivery. CARD = we text them a payment link and the order waits for payment.',
            },
            notes: { type: 'string', description: 'Allergies, door instructions' },
          },
          // Both required: an order placed without knowing how it is being
          // paid for is one the shop has to ring the customer back about.
          required: ['customerName', 'paymentMethod'],
        },
      },
      {
        name: 'take_message',
        description:
          'Record a message for the shop to deal with later, when you cannot help and nobody can take the call.',
        input_schema: {
          type: 'object',
          properties: {
            message: { type: 'string' },
            callerName: { type: 'string' },
          },
          required: ['message'],
        },
      },
      {
        name: 'transfer_to_staff',
        description:
          'Hand the call to a human. Use freely — for complaints, anything you cannot do, or a second misunderstanding.',
        input_schema: {
          type: 'object',
          properties: { reason: { type: 'string' } },
          required: ['reason'],
        },
      },
      {
        name: 'end_call',
        description: 'Say goodbye and hang up, once the caller is done.',
        input_schema: {
          type: 'object',
          properties: { reason: { type: 'string' } },
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
      case 'find_item':
        return { result: this.findItem(String(input?.said ?? ''), ctx) };
      // use_usual is answered by VoiceService before it reaches here: it needs
      // the caller's number and the order history, neither of which belongs in
      // this file. Reaching this line means the chained engine offered it a
      // tool only the other engine has.
      case 'use_usual':
        return {
          result:
            'That is not available on this call. Take the order from the beginning — ask whether it is collection or delivery.',
        };
      case 'add_item':
        return this.addItem(input, ctx, state);
      case 'remove_item': {
        const before = state.cart.items.length;
        state.cart.items = state.cart.items.filter((l) => l.lineId !== String(input?.lineId));
        return {
          result:
            state.cart.items.length < before
              ? `Removed. Order is now:\n${summarizeCart(state.cart, ctx.currency)}`
              : "That line isn't on the order.",
        };
      }
      case 'set_fulfillment': {
        const type = input?.type === 'PICKUP' ? 'PICKUP' : 'DELIVERY';
        state.cart.fulfillmentType = type;
        state.cart.fulfillmentChosen = true;
        if (type === 'PICKUP') {
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
              .join(
                ', ',
              )}. Ask "are you still at ${state.savedAddress.line1}?" — do not read the whole thing out.`,
          };
        }
        return {
          result:
            'Set to delivery. Now ask for their address including the postcode, giving the example, then call propose_delivery_address.',
        };
      }

      case 'resolve_address':
        return { result: await this.resolveAddressTool(String(input?.said ?? ''), ctx, state) };
      case 'lookup_postcode':
        return { result: await this.lookupPostcode(String(input?.said ?? ''), ctx, state) };
      case 'propose_delivery_address': {
        // An address needs whatever locates it here — a postcode in the UK, a
        // community in the Gulf. Requiring a postcode meant a Dubai caller
        // could never get past this, and the order was stamped "GB" besides.
        const line1 = String(input?.line1 ?? '').trim();
        if (!line1) {
          return { result: 'No street or house number heard — ask again.' };
        }
        // A real call gave us "E10, 8YH" for a caller who said "NE10 8YH" —
        // the leading letter did not survive the audio. If the shop delivers
        // to exactly one area whose outward code ends with what we heard, that
        // is not a guess, it is the only possibility. Two candidates and we
        // say nothing and let them be asked again.
        // The postcode lookup_postcode just resolved is the postcode, whether
        // or not the model passes it back. On a live call it did not, the
        // address went in without one, and a £3 delivery was priced at
        // nothing. A postcode-priced shop does not take an address without
        // one.
        const heard = input?.postcode ? String(input.postcode) : undefined;
        const postcode =
          (heard
            ? (resolveHeardPostcode(
                heard,
                ctx.deliveryZones.map((z) => z.postcodePrefix),
              ) ?? undefined)
            : undefined) ?? state.addr?.postcode ?? undefined;
        if (!postcode && zoneMode(ctx.deliveryZones as any) === 'POSTCODE' && postcodeRequiredFor(ctx.country)) {
          return {
            result: 'Not taken — there is no postcode for this address, and delivery is priced by postcode. Ask for the postcode, run lookup_postcode, then propose the address again.',
          };
        }

        state.cart.fulfillmentType = 'DELIVERY';
        state.cart.fulfillmentChosen = true;
        state.cart.deliveryAddress = {
          line1,
          city: String(input?.city ?? ctx.address?.city ?? ''),
          postcode,
          area: input?.area ? String(input.area) : undefined,
          country: ctx.country,
        };
        // Proposing a NEW address always un-confirms — otherwise a correction
        // inherits the yes the caller gave to the address they just rejected.
        state.addressConfirmed = false;

        const spoken = this.spokenAddress(state.cart.deliveryAddress);
        state.awaiting = 'ADDRESS_CONFIRM';
        return {
          result:
            'Address taken and read back to the caller. Wait for their answer. Call confirm_delivery_address only if they say yes; if they say no, take it again.',
          sayNow: `So that's ${spoken}. Is that correct?`,
        };
      }

      case 'confirm_delivery_address': {
        const addr = state.cart.deliveryAddress;
        if (!addr?.line1) {
          return { result: 'There is no address to confirm — take one first.' };
        }
        // The same yes the saved address needs. The address was read back;
        // this tool means the caller said it was right. A model that calls it
        // on its own initiative sends a driver to whatever it heard.
        const said = this.agreed(input, state);
        if (!said.ok && said.unclear) {
          return this.confirmByKeypad(
            state,
            'address',
            `Sorry — I didn't catch that. Is ${addr.line1} the right address?`,
          );
        }
        if (!said.ok) {
          state.pendingConfirm = undefined;
          state.addressConfirmed = false;
          state.addressConfirmedOf = undefined;
          return {
            result: `They have not said that address is right — ${said.why}. Ask what needs correcting and take it again.`,
          };
        }
        state.pendingConfirm = undefined;
        // The fee is quoted from the same resolver every other surface uses,
        // at the moment the address is finally agreed — not from whatever was
        // guessed earlier in the call.
        const check = this.checkArea(
          zoneMode(ctx.deliveryZones as any) === 'AREA'
            ? String(addr.area ?? '')
            : String(addr.postcode ?? ''),
          ctx,
        );
        if (check.startsWith('The shop does NOT deliver')) {
          state.addressConfirmed = false;
          return { result: check };
        }
        state.addressConfirmed = true;
        state.addressConfirmedOf = this.addressFingerprint(state);
        return {
          result: `Address confirmed. ${check} Tell them the delivery charge, then ask what they would like to order.`,
        };
      }

      case 'use_saved_address': {
        // They have to have SAID yes.
        //
        // "Are you still at 11 Sunningdale Drive?" — no answer arrived, and
        // ten seconds later this ran anyway and the order went to an address
        // the caller had spent the call trying to change. There is a NO MEANS
        // NO section in the prompt about exactly this; a prompt is a request,
        // and the address a driver is sent to is not something to request.
        //
        // Nothing heard is not a yes either. Silence is the case that caused
        // this, and it is the one a model is most likely to fill in for
        // itself.
        const consent = this.agreed(input, state);
        if (!consent.ok && consent.unclear) {
          const saved = state.savedAddress;
          return this.confirmByKeypad(
            state,
            'address',
            saved?.line1
              ? `Sorry — I didn't catch that. Are you still at ${saved.line1}?`
              : "Sorry — I didn't catch that. Is the address we have on file still right?",
          );
        }
        if (!consent.ok) {
          state.pendingConfirm = undefined;
          return {
            result: `They have not said yes to the address on file — ${consent.why}. Do NOT use it. Ask "No problem — what's the delivery address?" and take the new one.`,
          };
        }
        state.pendingConfirm = undefined;
        const saved = state.savedAddress;
        if (!saved?.line1) {
          return {
            result: 'There is no saved address for this caller — take one the normal way.',
          };
        }
        state.cart.fulfillmentType = 'DELIVERY';
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
        state.addressConfirmedOf = this.addressFingerprint(state);
        // A saved address carries a postcode, not a named community, so in an
        // area-priced shop there is nothing here to check it against. Ask,
        // rather than quoting a fee resolved from the wrong field.
        if (zoneMode(ctx.deliveryZones as any) === 'AREA') {
          return {
            result:
              'Using their saved address. Ask which area that is in and run check_delivery_area before quoting a delivery charge.',
          };
        }
        const check = this.checkArea(String(saved.postcode ?? ''), ctx);
        return {
          result: `Using their saved address. ${check} Now ask what they would like to order.`,
        };
      }

      case 'read_back_order': {
        if (state.cart.items.length === 0) {
          return { result: 'Nothing on the order yet — there is nothing to read back.' };
        }
        if (
          state.cart.fulfillmentType === 'DELIVERY' &&
          zoneMode(ctx.deliveryZones as any) === 'POSTCODE' &&
          postcodeRequiredFor(ctx.country) &&
          !state.cart.deliveryAddress?.postcode
        ) {
          return {
            result: 'Not read back — the delivery address has no postcode, so the delivery charge cannot be worked out. Get the postcode and propose the address again first.',
          };
        }
        if (state.pendingItem) {
          return {
            result:
              'An item is still being finished — its choices or note have not all been answered yet. Do not read the order back until it is in the basket.',
          };
        }
        state.awaiting = 'ORDER_CONFIRM';
        // The read-back is a statement about THIS order. A yes to it does not
        // cover anything added, removed or changed afterwards.
        state.readBackOf = this.orderFingerprint(state);
        return {
          result:
            'Order read back to the caller. Wait for their answer. Call order_confirmed if they say yes; if they say no, ask what needs changing.',
          sayNow: this.readBackScript(ctx, state),
        };
      }

      case 'order_confirmed': {
        if (state.cart.items.length === 0) {
          return { result: 'The order is empty — nothing to confirm.' };
        }
        if (state.pendingItem) {
          return {
            result:
              'An item is still being finished. Nothing can be confirmed until it is in the basket.',
          };
        }
        const now = this.orderFingerprint(state);
        if (state.readBackOf !== now) {
          state.orderConfirmed = false;
          state.orderConfirmedOf = undefined;
          return {
            result: state.readBackOf
              ? 'The order has CHANGED since it was read back. Call read_back_order again, say it, and get a fresh yes for the order as it is now.'
              : 'The order has not been read back. Call read_back_order first — a yes only counts for an order the caller has heard.',
          };
        }
        // The read-back is the last gate before a kitchen starts cooking. A
        // yes heard where there was none puts food nobody ordered on a
        // stranger's doorstep, and the caller pays for it.
        const agreedToOrder = this.agreed(input, state);
        if (!agreedToOrder.ok && agreedToOrder.unclear) {
          return this.confirmByKeypad(
            state,
            'order',
            "Sorry — I didn't catch that. Is that order all correct?",
          );
        }
        if (!agreedToOrder.ok) {
          state.pendingConfirm = undefined;
          return {
            result: `They have not confirmed the order — ${agreedToOrder.why}. Do NOT place it. Ask them plainly: "Is that all correct?" and wait for a clear yes.`,
          };
        }
        state.pendingConfirm = undefined;
        state.orderConfirmed = true;
        state.orderConfirmedOf = now;
        return {
          result:
            'Confirmed. Now ask how they would like to pay — cash, or card — and then place it.',
        };
      }
      case 'check_delivery_area':
        return {
          result: this.checkArea(String(input?.area ?? input?.postcode ?? ''), ctx),
        };
      case 'get_opening_hours':
        return { result: this.openingHours(ctx) };
      case 'get_order_status':
        return { result: await this.orderStatus(ctx, callerNumber, input?.orderNumber) };
      case 'amend_order':
        return this.amendOrder(ctx, state);
      case 'place_order':
        // An amendment is not a new order. Placing one here would leave the
        // caller with two — the one they rang about and a duplicate of it
        // carrying the extras.
        if (state.amendOrderId) {
          return {
            result:
              'This caller is CHANGING an order that already exists. Use amend_order, not place_order.',
          };
        }
        return this.placeOrder(input, ctx, state, callerNumber);
      case 'take_message': {
        state.message = String(input?.message ?? '').slice(0, 1000);
        return {
          result: 'Message saved for the shop.',
          turn: { outcome: 'ENQUIRY' },
        };
      }
      case 'transfer_to_staff': {
        // Handing over because WE could not hear is the failure this line was
        // built to avoid. The caller rang a shop that did not answer; being
        // bounced by the thing that did answer, over a word, is worse than
        // either. A real request for a person always goes through — this only
        // ever refuses "I keep mishearing them".
        const why = String(input?.reason ?? '').toLowerCase();
        const onlyMisheard =
          /(mishear|misheard|not understand|didn'?t understand|can'?t understand|unclear|couldn'?t catch|didn'?t catch|hard to hear|trouble hearing)/.test(
            why,
          );
        if (onlyMisheard && !state.askedForHuman && (state.confusion ?? 0) < 3) {
          state.confusion = (state.confusion ?? 0) + 1;
          return {
            result:
              'Not yet. Mishearing is not a reason to hand over — ask again, in DIFFERENT words, and ask for a smaller piece of it than last time. Take a postcode on its own, or ask them to spell it. If you still cannot get there after a few goes, ASK them whether they would like to be put through rather than doing it to them.',
          };
        }
        return {
          result: ctx.transferNumber
            ? 'Transferring now.'
            : 'No transfer number configured — take a message instead.',
          turn: ctx.transferNumber
            ? { transferTo: ctx.transferNumber, outcome: 'TRANSFERRED' }
            : undefined,
        };
      }
      case 'end_call': {
        // Never hang up on a basket. Somebody spent that call choosing food.
        if (state.cart.items.length > 0 && !state.orderId) {
          return {
            result:
              'There is an unplaced order on this call. Do not hang up. Either finish placing it, or offer to take a message so the shop can ring them back.',
          };
        }
        return { result: 'Ending call.', turn: { endCall: true } };
      }
      default:
        return { result: `Unknown tool ${name}` };
    }
  }

  /**
   * Add what they just asked for, without asking the model.
   *
   * Every turn of an order was costing a model round trip — five to eight
   * seconds each, on the part of the call with the most turns in it. But
   * "three cokes and a garlic bread" needs no reasoning: the matcher already
   * decides which dish that is, and it is the same matcher the model's own
   * add_item calls go through. The model was being paid to relay.
   *
   * Deliberately all-or-nothing. If any part of the burst is unclear, or any
   * dish needs a choice made about it, the WHOLE utterance goes to the model —
   * half an order added behind the caller's back is worse than a slow turn.
   * Returns null to mean "not mine".
   */
  quickAddAloud(
    ctx: VoiceContext,
    state: VoiceState,
    said: string,
  ): { say: string; next?: VoiceState['awaiting'] } | null {
    const text = String(said ?? '').trim();
    if (!text || !ctx.items?.length) return null;

    // Anything that is not plainly "I would like X" belongs to the model:
    // changing an order, asking a question, or finishing one.
    if (
      /\b(remove|cancel|change|instead|actually|without|no |not |swap|delete|take off)\b/i.test(
        text,
      ) ||
      /\b(that'?s (it|all|everything)|nothing else|how much|what'?s|do you|can i get a menu|read.?back|total)\b/i.test(
        text,
      ) ||
      /\?/.test(text)
    ) {
      return null;
    }

    const phrases = text
      .replace(/\b(and also|as well as|along with)\b/gi, ',')
      // NOT "with" — that introduces an option, not another dish. Splitting on
      // it turned "a doner kebab with chilli" into a kebab and a mystery
      // second item called chilli, and sent the whole thing to the model.
      .split(/\s*(?:,|\band\b|\bplus\b)\s*/i)
      .map((p) =>
        p
          .replace(
            /^(can i (get|have)|could i (get|have)|i'?ll have|i want|i would like( to order)?|please|just)\s+/i,
            '',
          )
          .trim(),
      )
      .filter((p) => p.length > 1);
    if (!phrases.length || phrases.length > 8) return null;

    // "and with the garlic sauce on it" is not a dish, it is more about the
    // dish before it. Split on "and" it became an item nobody sells, and one
    // unmatched fragment used to abandon the entire order.
    const merged: string[] = [];
    for (const phrase of phrases) {
      if (/^(with|extra|on it|on the side)\b/i.test(phrase) && merged.length) {
        merged[merged.length - 1] += ` ${phrase}`;
      } else {
        merged.push(phrase);
      }
    }

    const resolved: Array<{ item: any; quantity: number; phrase: string }> = [];
    let sizeOpen: { group: any; quantity: number } | null = null;
    const leftovers: string[] = [];

    for (const phrase of merged) {
      // Which reading of a leading number the menu actually supports — four of
      // something, or the dish called "Four Meat".
      const { quantity, matches } = matchWithQuantity(phrase, ctx.items, {
        limit: 3,
        floor: 0.3,
      });

      // One phrase, several dishes. People do not say "and" between every
      // item — they pause, and the pause does not survive transcription. Read
      // "twelve inch pepperoni chips" as two things rather than scoring it as
      // the name of one and throwing all of it away.
      //
      // A confident match is not enough to skip this. Scoring ignores words
      // the dish does not have, so "kebab pizza cheesy chips" is a confident
      // Cheesy Chips — and a whole pizza goes in the bin unremarked. If the
      // winner cannot account for the words, the phrase is more than one dish.
      const wholeFits = isConfidentGroup(matches) && explains(phrase, matches[0]!.group);
      if (!wholeFits) {
        const { found, leftovers: unread } = segmentItems(phrase, ctx.items, {
          limit: 3,
          floor: 0.3,
        });
        if (found.length > 1) {
          for (const hit of found) {
            const group = hit.match.group;
            const item =
              group.variants.length === 1
                ? group.variants[0]!
                : pickVariant(hit.phrase, group.variants);
            if (item) {
              resolved.push({ item, quantity: hit.quantity, phrase: hit.phrase });
            } else if (!sizeOpen) {
              sizeOpen = { group, quantity: hit.quantity };
            }
          }
          // Only the words that belonged to nothing are asked about.
          if (unread.join(' ').trim().split(/\s+/).filter(Boolean).length > 1) {
            leftovers.push(unread.join(' '));
          }
          continue;
        }
      }

      if (!isConfidentGroup(matches)) {
        // The one log line that makes a weak match diagnosable. Without it,
        // "it doesn't understand food" is a report nobody can act on: this
        // says which dishes it weighed and how close each one came.
        this.logger?.log(
          `no confident match for "${phrase}" — ${
            matches.length
              ? matches.map((m) => `${m.group.base}:${m.score.toFixed(2)}`).join(', ')
              : 'nothing above 0.30'
          }`,
        );
        // A single stray word is a hesitation, not an order. Real transcripts:
        // "always...", "erm". Anything longer is something they asked for and
        // we could not place, and it must be asked about rather than dropped.
        if (phrase.trim().split(/\s+/).length > 1) leftovers.push(phrase);
        continue;
      }

      const { group } = matches[0]!;
      const item =
        group.variants.length === 1 ? group.variants[0]! : pickVariant(phrase, group.variants);
      if (!item) {
        if (sizeOpen) return null; // two open sizes is a conversation
        sizeOpen = { group, quantity };
        continue;
      }
      resolved.push({ item, quantity, phrase });
    }

    // Nothing we could place. The model gets the whole utterance, untouched.
    if (!resolved.length && !sizeOpen) return null;

    // Add everything that needs no decision made about it, and hold back at
    // most ONE dish that does — a turn asks one question.
    const needsChoice = resolved.filter((r) =>
      r.item.modifierGroups?.some((g: any) => mustChoose(g)),
    );
    if (needsChoice.length > 1) return null;
    const straight = resolved.filter((r) => !needsChoice.includes(r));

    for (const { item, quantity } of straight) {
      state.cart.items.push({
        lineId: Math.random().toString(36).slice(2, 9),
        itemId: item.id,
        name: item.name,
        quantity,
        unitBasePrice: item.price,
        modifiers: [],
      } as any);
    }

    const added = straight.map(({ item, quantity }) => this.spokenLine(item.name, quantity));
    const opener = added.length ? `Got it — ${this.listAloud(added)}.` : '';

    // One question, and this is the order they matter in.
    if (needsChoice.length === 1) {
      const { item, quantity } = needsChoice[0]!;
      state.pendingItem = { itemId: item.id, quantity, chosen: [] };
      // The WHOLE utterance, not just this dish's phrase. A caller says "and
      // with the garlic sauce on it" at the end of a long order, and which
      // fragment that lands next to depends on where they paused — in a real
      // call it landed beside a hesitation and the sauce was lost, so we asked
      // for something they had already told us. Only one dish per burst is
      // allowed to need a choice, so there is nothing for this to confuse.
      this.absorbOptions(item, state, text);
      const ask = this.askNextOption(ctx, state);
      if (ask) return { say: `${opener} ${ask.say}`.trim(), next: ask.next };
      // Every choice was already answered in the same breath as the order, so
      // the only thing left to offer is the note. Same question either way:
      // whether the sauce was asked for or volunteered changes nothing about
      // whether the kitchen needs telling something.
      const done = this.askNoteOrCommit(ctx, state);
      if (state.pendingItem) {
        return { say: `${opener} ${done}`.trim(), next: 'ITEM_NOTE' };
      }

      if (!opener) return { say: done };
      return {
        say: `${opener.replace(/\.$/, '')} and ${done.replace(/^Got it — /, '')}`,
      };
    }

    if (sizeOpen) {
      state.pendingItem = {
        variantIds: sizeOpen.group.variants.map((v: any) => v.id),
        quantity: sizeOpen.quantity,
        chosen: [],
      };
      state.choices = sizeOpen.group.variants.map((v: any) => v.id);
      state.pendingItem.walked = true;
      return {
        say: `${opener} What size ${sizeOpen.group.base} would you like — ${sizesAloud(
          sizeOpen.group.variants,
        )}?`.trim(),
        next: 'ITEM_OPTION',
      };
    }

    if (leftovers.length) {
      // Say what landed, then ask only for the part that didn't. Repeating one
      // item is a different experience from repeating the whole order.
      return { say: `${opener} Sorry, what was the other one?`.trim() };
    }

    return { say: `${opener} Anything else?`.trim() };
  }

  /** "A, B and C" — said the way a person lists things. */
  private listAloud(parts: string[]): string {
    if (parts.length <= 1) return parts[0] ?? '';
    return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
  }

  /** A menu name as it should be said: 'Margherita (14")' is not speech. */
  private spokenLine(name: string, quantity: number): string {
    const { base, size } = splitSize(name);
    const label = size ? `${base}, ${size.replace(/"/g, ' inch').trim()}` : base;
    return quantity > 1 ? `${quantity} ${label}` : label;
  }

  /**
   * Anything they already said that answers a required choice.
   *
   * "A doner with chilli sauce" answers the sauce question in the same breath
   * it asks for the dish, and asking it back is how a line feels like a form.
   */
  private absorbOptions(item: any, state: VoiceState, phrase: string): void {
    if (!state.pendingItem) return;
    for (const group of item.modifierGroups ?? []) {
      if (!mustChoose(group)) continue;
      if (group.options.some((o: any) => state.pendingItem!.chosen.includes(o.id))) continue;
      const matches = matchMenuItems<any>(phrase, group.options, { limit: 2, floor: 0.75 });
      if (isConfident(matches)) state.pendingItem.chosen.push(matches[0]!.item.id);
    }
  }

  /**
   * The first required choice still outstanding, read out with its numbers.
   *
   * Said in full — "for your wrap, press 1 for Gyros Wrap, 2 for Falafel, 3
   * for Halloumi" — because the operator tried both on live calls and this is
   * the one that gets orders through. It costs a few seconds a question
   * against asking it conversationally, and buys a choice that cannot be
   * misheard: no accent, no line noise and no menu word the transcriber has
   * never been trained on can turn a 2 into something else.
   *
   * Speaking still works everywhere pressing does. Nobody is forced to use the
   * keypad — they are simply always able to.
   */
  /** "Select Pizza Size" → "pizza size". The verb was for a screen. */
  private groupLabel(name: string): string {
    return (
      String(name ?? '')
        .toLowerCase()
        .replace(/^(please\s+)?(select|choose|pick)\s+(your\s+|a\s+|the\s+)?/, '')
        .replace(/^your\s+/, '')
        .trim() || 'option'
    );
  }

  /** "thin, deep pan or stuffed" */
  private spokenList(names: string[], joiner: 'or' | 'and' = 'or'): string {
    const n = names.map((x) => String(x).trim()).filter(Boolean);
    if (n.length <= 1) return n[0] ?? '';
    return `${n.slice(0, -1).join(', ')} ${joiner} ${n[n.length - 1]}`;
  }

  private askNextOption(
    ctx: VoiceContext,
    state: VoiceState,
  ): { say: string; next: VoiceState['awaiting'] } | null {
    const pending = state.pendingItem;
    const item = pending?.itemId ? ctx.itemIndex.get(pending.itemId) : undefined;
    if (!pending || !item) return null;

    for (const group of item.modifierGroups ?? []) {
      if (!mustChoose(group)) continue;
      const picked = group.options.filter((o: any) => pending.chosen.includes(o.id));
      if (picked.length >= needed(group)) continue;

      // Asked the way a person asks it: the choices, said, and "which would
      // you like?" The numbers are still recorded in speech order so a key
      // press answers exactly the same question — and after two answers the
      // line could not make out, they are offered aloud as the way through.
      const offered = group.options.slice(0, 8);
      state.choices = offered.map((o: any) => o.id);
      // Decided BEFORE walked is set: the first thing said about a dish names
      // it — "Pepperoni Pizza comes with…" — even when the caller already
      // answered the size in their order; every question after is "And for…".
      const first = !pending.walked && !pending.overview;
      pending.walked = true;
      const label = this.groupLabel(group.name);
      const list = this.spokenList(offered.map((o: any) => this.spokenSize(o.name)));
      const more = group.options.length > offered.length ? ', or something else' : '';
      const numbers =
        (pending.misses ?? 0) >= 2
          ? ` Or press ${offered.map((o: any, i: number) => `${i + 1} for ${this.spokenSize(o.name)}`).join(', ')}.`
          : '';
      const { base } = splitSize(item.name);
      const say = first
        ? `${base} comes with a choice of ${label} — ${list}${more}. Which would you like?${numbers}`
        : `And for the ${label} — ${list}${more}?${numbers}`;
      return { say, next: 'ITEM_OPTION' };
    }
    return null;
  }

  /**
   * Every choice made. Offer the kitchen a note before the line is committed.
   *
   * "No onions", "extra crispy", "cut in half" — the things a caller says at
   * the counter and has no way to say to a phone tree. Asked once per line and
   * answered with a keypress by anyone who has nothing to add.
   */
  private askNoteOrCommit(ctx: VoiceContext, state: VoiceState): string {
    const pending = state.pendingItem;
    if (!pending) return '';
    if (pending.notesAsked) return this.commitPendingItem(ctx, state);
    // Only after a walkthrough. A caller who said "a doner with chilli" in one
    // breath told us everything already, and answering a question they were
    // never asked with a note they do not have is how a line grows a step per
    // item for no reason.
    if (!pending.walked) return this.commitPendingItem(ctx, state);
    pending.notesAsked = true;
    state.choices = undefined;
    const item = pending.itemId ? ctx.itemIndex.get(pending.itemId) : undefined;
    const { base } = splitSize(item?.name ?? 'that');
    return `Any notes for the ${base.toLowerCase()} — anything like no onions or extra sauce? Say it now, or press 1 if not.`;
  }

  /**
   * The next thing to say once a choice has landed.
   *
   * Named back first. Somebody who pressed 2 has no idea whether it registered
   * or what it registered AS — they pressed a key into silence and got a
   * different question. One word closes that: "Twelve inch. Any notes...?"
   * The commit line already names everything, so it does not need it twice.
   */
  private afterOption(ctx: VoiceContext, state: VoiceState, chosen?: string): string {
    const said = chosen ? `${chosen.trim().replace(/[.]$/, '')}. ` : '';
    const next = this.askNextOption(ctx, state);
    if (next) return `${said}${next.say}`;
    const pending = state.pendingItem;
    const willAsk = pending && !pending.notesAsked && pending.walked;
    const rest = this.askNoteOrCommit(ctx, state);
    return willAsk ? `${said}${rest}` : rest;
  }

  /**
   * Their answer to "any notes?".
   *
   * Anything that is not a refusal is the note itself, because that is what a
   * caller says: they do not say "yes" and wait to be asked again.
   */
  answerItemNote(ctx: VoiceContext, state: VoiceState, said: string): string | null {
    const pending = state.pendingItem;
    if (!pending) return null;
    const text = String(said ?? '').trim();
    if (!text) return null;

    // The WHOLE utterance, not its first word. "No onions" is the commonest
    // note on any takeaway ticket and it begins with "no" — reading that as a
    // refusal drops the one instruction the kitchen actually needed, silently,
    // and the caller has no way of knowing it went nowhere.
    const refusal =
      /^(no|none|nope|nah|nothing|no thanks?|no thank you|no that'?s it|that'?s it|thats it|all good|i'?m good|we'?re good)[.!]?$/i;
    if (refusal.test(text)) return this.commitPendingItem(ctx, state);
    // A "yes" on its own is somebody agreeing to add one, not the note.
    if (parseYesNo(text) === 'YES' && text.split(/\s+/).length <= 2) {
      return 'Go ahead — what would you like me to put on it?';
    }
    pending.notes = text
      .replace(/^(yes,?\s*|please\s+)/i, '')
      .trim()
      .slice(0, 200);
    return this.commitPendingItem(ctx, state);
  }

  /** Their answer to a required choice. Null means we could not tell. */
  answerItemOption(ctx: VoiceContext, state: VoiceState, said: string): string | null {
    const pending = state.pendingItem;
    if (!pending) return null;

    // The outstanding question is the size.
    if (!pending.itemId && pending.variantIds?.length) {
      const variants = pending.variantIds
        .map((id) => ctx.itemIndex.get(id))
        .filter(Boolean) as any[];
      const chosen = pickVariant(said, variants);
      if (!chosen) {
        pending.misses = (pending.misses ?? 0) + 1;
        return null;
      }
      pending.itemId = chosen.id;
      pending.variantIds = undefined;
      this.absorbOptions(chosen, state, said);
      return this.afterOption(ctx, state);
    }

    const item = pending.itemId ? ctx.itemIndex.get(pending.itemId) : undefined;
    if (!item) return null;

    for (const group of item.modifierGroups ?? []) {
      if (!mustChoose(group)) continue;
      const picked = group.options.filter((o: any) => pending.chosen.includes(o.id));
      if (picked.length >= needed(group)) continue;

      // A closed list of three, not a menu of two hundred: "gyros" answers
      // "which wrap?" and must not be sent to a model to think about.
      const answer = matchOption<any>(said, group.options, group.name);
      if (!answer) {
        // Not an answer to THIS question — but "margherita, chips and a
        // coke" answers three at once, which is what a meal deal invites.
        // Anything the utterance names confidently, in any group, is taken.
        const before = pending.chosen.length;
        this.absorbOptions(item, state, said);
        if (pending.chosen.length > before) {
          const names = pending.chosen
            .slice(before)
            .map((id) => ctx.optionIndex.get(id)?.option?.name)
            .filter(Boolean)
            .map((n) => this.spokenSize(String(n)));
          return this.afterOption(ctx, state, this.spokenList(names));
        }
        pending.misses = (pending.misses ?? 0) + 1;
        return null;
      }
      const before = pending.chosen.length;
      pending.chosen.push(answer.item.id);
      // "Margherita, doner, chips and a fanta" answers the pizza question AND
      // the three after it. Whatever else the same breath named, take now,
      // or the caller is asked for things they have just said.
      this.absorbOptions(item, state, said);
      const names = pending.chosen
        .slice(before)
        .map((id) => ctx.optionIndex.get(id)?.option?.name ?? '')
        .filter(Boolean)
        .map((n) => this.spokenSize(String(n)));
      return this.afterOption(ctx, state, this.spokenList(names));
    }
    return this.askNoteOrCommit(ctx, state);
  }

  /**
   * They pressed a number instead of saying it.
   *
   * Nothing was read out as "press 1 for…", so this is not a phone tree — the
   * numbers simply follow the order the options were spoken in, and are there
   * for the caller on a bad line, in a car, or with a toddler shouting. Null
   * means that key means nothing here, which must leave the call exactly where
   * it was rather than guessing.
   */
  chooseByNumber(ctx: VoiceContext, state: VoiceState, digit: string): string | null {
    const pending = state.pendingItem;
    const n = Number(String(digit ?? '').trim());
    if (!pending || !state.choices?.length) return null;
    if (!Number.isInteger(n) || n < 1 || n > state.choices.length) return null;
    const id = state.choices[n - 1]!;

    // The outstanding question is the size, so the number picks the variant.
    if (!pending.itemId && pending.variantIds?.length) {
      const chosen = ctx.itemIndex.get(id);
      if (!chosen || !pending.variantIds.includes(id)) return null;
      pending.itemId = chosen.id;
      pending.variantIds = undefined;
      pending.misses = 0;
      state.choices = undefined;
      const { size } = splitSize(chosen.name);
      return this.afterOption(ctx, state, size ? this.spokenSize(size) : undefined);
    }

    const item = pending.itemId ? ctx.itemIndex.get(pending.itemId) : undefined;
    const group = (item?.modifierGroups ?? []).find((g: any) =>
      g.options?.some((o: any) => o.id === id),
    );
    if (!group) return null;
    const picked = group.options.find((o: any) => o.id === id);
    pending.chosen.push(id);
    pending.misses = 0;
    state.choices = undefined;
    return this.afterOption(ctx, state, this.spokenSize(picked?.name));
  }

  /**
   * Did the caller actually agree?
   *
   * Three tools change what a kitchen makes on the strength of a yes: the
   * address on file, the order they had last time, and the read-back. A model
   * listening to a bad line will occasionally hear one where there was none —
   * "no, I don't want the same as last time" came back as "Sienos." and the
   * previous order went straight into the basket.
   *
   * So the caller's own words decide, and anything that is not a yes is not a
   * yes: silence, noise, a mangled transcript, or a sentence about something
   * else. The cost of being wrong here is a stranger's dinner cooked and sent
   * to the wrong door; the cost of asking again is four seconds.
   */
  /**
   * Ask it again with the keypad.
   *
   * Reached only once speech has already failed to produce a readable answer.
   * "Svensk." was a no and "Телигов." was a yes on a real call, and asking the
   * same question the same way simply collects another one of those — so the
   * next attempt stops relying on the microphone at all.
   */
  confirmByKeypad(
    state: VoiceState,
    intent: NonNullable<VoiceState['pendingConfirm']>['intent'],
    question: string,
  ): { result: string; sayNow?: string } {
    if ((state as any).__conversation === true) {
      // No keypad on this engine. They have not answered; ask again, in
      // words, and wait for a real turn before acting.
      return {
        result: `They haven't answered since you asked. Ask again in one short sentence — "${question}" — then WAIT for them to speak. Do not act until they have.`,
      };
    }
    state.pendingConfirm = { intent, asked: true, of: this.fingerprintFor(intent, state) };
    return {
      sayNow: `${question} Press 1 for yes, or 2 for no.`,
      result:
        'Their answer could not be made out, so they have been asked to press 1 or 2. That keypress is handled in code — say nothing more, and do NOT act until it arrives.',
    };
  }

  /** What goes on the ticket as the caller's name — never the last word they said. */
  private customerNameFrom(raw: unknown, state: VoiceState): string {
    const t = String(raw ?? '').trim();
    const notAName =
      !t ||
      t.length > 60 ||
      /^(cash|card|credit|debit|pay|payment|yes|yeah|yep|no|nope|ok|okay|delivery|collection|pickup|phone order)[.!]?$/i.test(
        t,
      );
    if (!notAName) return t;
    return state.knownName?.trim() || 'Phone order';
  }

  /**
   * The order as it stands, as one string. Same order → same string.
   *
   * Everything a caller could be confirming: what, how many, with what on it,
   * any note, collection or delivery, and where. Prices are derived from these
   * so they need not be listed. Nothing here is a timestamp or an id, so
   * reading it back twice without touching it gives the same fingerprint.
   */
  orderFingerprint(state: VoiceState): string {
    const items = (state.cart.items ?? []).map((i: any) => ({
      id: i.menuItemId ?? i.id ?? i.name,
      q: i.quantity,
      m: (i.modifiers ?? []).map((m: any) => m.id ?? m.optionId ?? m.name).sort(),
      n: i.notes ?? i.note ?? '',
    }));
    return JSON.stringify({
      items,
      f: state.cart.fulfillmentType ?? null,
      a: this.addressFingerprint(state),
    });
  }

  addressFingerprint(state: VoiceState): string {
    const a: any = state.cart.deliveryAddress;
    if (!a) return '';
    return JSON.stringify([a.line1 ?? '', a.city ?? '', a.postcode ?? '', a.area ?? '']);
  }

  /** The thing a keypad question would be about, for this intent. */
  private fingerprintFor(intent: 'usual' | 'address' | 'order', state: VoiceState): string {
    return intent === 'address' ? this.addressFingerprint(state) : this.orderFingerprint(state);
  }

  /** Confirmed, and nothing about the address has changed since. */
  addressStillConfirmed(state: VoiceState): boolean {
    return (
      state.addressConfirmed === true &&
      !!state.addressConfirmedOf &&
      state.addressConfirmedOf === this.addressFingerprint(state)
    );
  }

  /** Confirmed, and nothing about the order has changed since. */
  orderStillConfirmed(state: VoiceState): boolean {
    return (
      state.orderConfirmed === true &&
      !!state.orderConfirmedOf &&
      state.orderConfirmedOf === this.orderFingerprint(state)
    );
  }

  agreed(input: any, state?: VoiceState): { ok: boolean; why: string; unclear?: boolean } {
    const heard = String(input?.__heard ?? '').trim();

    // The conversation engine: the model reports the yes, the line proves a
    // turn happened. Nothing reads the transcript's words — on 8kHz they are
    // the one thing that cannot be trusted — but a yes with no caller turn
    // since the question was asked is the model answering for them, and
    // that is refused exactly as it was on the other engine.
    if (input?.__conversation === true) {
      if (input?.__spokeAfterQuestion === true) {
        return { ok: true, why: 'the caller spoke after the question and the model reports a yes' };
      }
      return { ok: false, unclear: true, why: 'the caller has not spoken since you asked' };
    }

    // A keypress outranks the transcript. It is the same yes, typed instead of
    // spoken, and it is the only answer on the call that cannot be garbled.
    const pressed = state?.pendingConfirm;
    if (pressed?.answered && state) {
      // Stale if the basket or address moved between the question and the
      // key. The press answered a question about something that no longer
      // exists; it must not be spent on what replaced it.
      const about = pressed.of;
      const now = this.fingerprintFor(pressed.intent, state);
      if (about !== undefined && about !== now) {
        return {
          ok: false,
          unclear: true,
          why: 'their keypress was about an earlier version of the order',
        };
      }
      if (pressed.answered === 'YES') return { ok: true, why: 'they pressed 1 for yes' };
      return { ok: false, why: 'they pressed 2 for no' };
    }

    // "Unclear" is not "no". A clear no is honoured and the call moves on; an
    // answer nobody could read has to be asked again A DIFFERENT WAY, because
    // asking it the same way gets the same unreadable answer forever — which
    // is what a caller experiences as the line being broken.
    // The transcript can arrive AFTER the tool it belongs to — 248ms after, on
    // the call that prompted this. A stale one is somebody else's answer.
    if (input?.__heardFresh === false) {
      return { ok: false, unclear: true, why: 'nothing they have said since you asked' };
    }
    if (!heard) return { ok: false, unclear: true, why: 'nothing at all' };
    // "Svensk." was a no and "Телигов." was a yes, on a real call. Neither is
    // a refusal — both are a small transcriber losing the language on 8kHz
    // audio, and reading them as answers is how the same question got asked
    // four times in a row.
    if (input?.__heardReadable === false) {
      return { ok: false, unclear: true, why: 'something the transcriber could not make out' };
    }
    // A refusal in a whole sentence is still a refusal. parseYesNo gives up
    // past four words on purpose — "no, and can I add chips" is a turn, not a
    // slot answer — but "no I don't want the same as last time" is as clear a
    // no as a person can give, and sending THAT to the keypad would make the
    // caller press 2 to repeat themselves.
    //
    // Only the no side is widened. Refusing costs four seconds; a yes invented
    // out of a long sentence costs a stranger's dinner, so a wordy yes still
    // goes to the keypad.
    const plainly = heard.toLowerCase().replace(/[^a-z\s']/g, ' ');
    if (
      /^\s*(no|nope|nah)\b/.test(plainly) ||
      /\b(don'?t want|do not want|not the same|nothing like|something else|rather not)\b/.test(
        plainly,
      )
    ) {
      return { ok: false, why: `"${heard.slice(0, 60)}"` };
    }
    const verdict = parseYesNo(heard);
    if (verdict === 'NO') {
      return { ok: false, why: `"${heard.slice(0, 60)}"` };
    }
    if (verdict !== 'YES') {
      return { ok: false, unclear: true, why: `"${heard.slice(0, 60)}"` };
    }
    return { ok: true, why: heard };
  }

  /** A size reads badly as a symbol: 12" is said "12 inch". */
  private spokenSize(name?: string | null): string {
    return String(name ?? '')
      .replace(/"/g, ' inch')
      .replace(/\s+/g, ' ')
      .trim();
  }

  /**
   * A turn that hands the caller to a person — or admits that it cannot.
   *
   * A shop with no transfer number and no published phone number has nobody to
   * hand to. Saying "let me put you through" and then not doing it leaves the
   * caller waiting on a line that has stopped talking to them, and marks the
   * call TRANSFERRED on the dashboard, so nobody ever finds out. Everything
   * that gives up on a call goes through here.
   */
  private handoverTurn(
    ctx: VoiceContext,
    why: string,
  ): { result: string; turn: Partial<VoiceTurn> } {
    if (ctx.transferNumber) {
      return {
        result: `${why} Tell them plainly and offer to put them through to the shop.`,
        turn: { transferTo: ctx.transferNumber, outcome: 'TRANSFERRED' },
      };
    }
    // No outcome, deliberately: the same shape the transfer tool already uses
    // when there is no number. Marking it TRANSFERRED would be a lie told to
    // the dashboard as well as to the caller.
    return {
      result: `${why} There is nobody to put them through to, so do NOT offer to — apologise, and ask if they would like to leave a message for the shop instead.`,
      turn: {},
    };
  }

  /** Every required choice made — put it in the cart. */
  private commitPendingItem(ctx: VoiceContext, state: VoiceState): string {
    const pending = state.pendingItem!;
    const item = ctx.itemIndex.get(pending.itemId!)!;
    const modifiers = pending.chosen
      .map((id) => ctx.optionIndex.get(id))
      .filter(Boolean)
      .map((m: any) => ({ optionId: m.option.id, name: m.option.name, price: m.option.price }));

    state.cart.items.push({
      lineId: Math.random().toString(36).slice(2, 9),
      itemId: item.id,
      name: item.name,
      quantity: pending.quantity,
      unitBasePrice: item.price,
      modifiers,
      ...(pending.notes ? { notes: pending.notes } : {}),
    } as any);
    state.pendingItem = undefined;
    state.choices = undefined;

    const { base, size } = splitSize(item.name);
    const label = size ? `${base}, ${size.replace(/"/g, ' inch').trim()}` : base;
    const withOpts = modifiers.length ? ` with ${modifiers.map((m) => m.name).join(' and ')}` : '';
    const qty = pending.quantity > 1 ? `${pending.quantity} ` : '';
    return `Got it — ${qty}${label}${withOpts}. Anything else?`;
  }

  // ── The conversation engine's view of the same brain ────────────────────
  //
  // Same transport as the speech-to-speech engine, different relationship
  // with the model. That engine wrapped gpt-realtime in a keypad menu, a slot
  // machine, numbered walkthroughs and consent gates read off a transcript —
  // each a patch for a real failure, and together the reason it felt like a
  // phone tree. This one gives the model the menu and the tools and lets it
  // hold the conversation, the way it does when it is not being puppeted.
  //
  // What stays are the rules that do not depend on hearing: a price is read
  // from the basket, an order is placed only for the basket that was read
  // back, an address is used only once it was confirmed. What goes is every
  // decision that was made by reading the sidecar transcript — because on an
  // 8kHz line the transcript is the one party that gets it wrong.

  /** "Hi, Chicago Pizzeria — what can I get you?" No numbers to press. */
  conversationGreeting(ctx: VoiceContext, knownName?: string | null): string {
    const shop = String(ctx.locationName ?? '').trim() || 'the shop';
    return knownName
      ? `Hi ${knownName}, welcome back to ${shop}. What can I get for you?`
      : `Hi, thanks for calling ${shop}. What can I get for you?`;
  }

  /**
   * The menu, small enough to live in the prompt.
   *
   * Every option of every item is what blew the instruction limit; the
   * names and prices are a few thousand tokens for a 150-item menu, and they
   * are what lets the model answer "what pizzas do you do?" like someone who
   * works there. Sizes fold into one line; an item that needs a choice is
   * starred, and add_item says which choice when it is asked for.
   */
  compactMenu(ctx: VoiceContext): string {
    const byCategory = new Map<string, any[]>();
    for (const it of ctx.items ?? []) {
      const cat = String((it as any).categoryName ?? 'Menu');
      if (!byCategory.has(cat)) byCategory.set(cat, []);
      byCategory.get(cat)!.push(it);
    }
    const lines: string[] = [];
    for (const [cat, items] of byCategory) {
      lines.push(`## ${cat}`);
      // Sized variants share a base name: "Margherita (10")", "Margherita (12")".
      const groups = new Map<string, any[]>();
      for (const it of items) {
        const { base } = splitSize(it.name);
        const key = base.toLowerCase();
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key)!.push(it);
      }
      for (const variants of groups.values()) {
        const needs = variants.some((v) =>
          (v.modifierGroups ?? []).some((g: any) => mustChoose(g)),
        );
        const star = needs ? ' *' : '';
        if (variants.length === 1) {
          const v = variants[0]!;
          lines.push(`- ${v.name} — ${money(v.price, ctx.currency)}${star}`);
        } else {
          const { base } = splitSize(variants[0]!.name);
          const sizes = variants
            .map((v) => {
              const { size } = splitSize(v.name);
              return `${(size || v.name).replace(/"/g, ' inch').trim()} ${money(v.price, ctx.currency)}`;
            })
            .join(', ');
          lines.push(`- ${base} — ${sizes}${star}`);
        }
      }
    }
    return lines.join('\n');
  }

  promptForConversation(ctx: VoiceContext, state: VoiceState, usual?: string | null): string {
    const shop = String(ctx.locationName ?? '').trim() || 'the shop';
    const lang = ctx.spokenLanguage ?? 'English';
    const currency = currencyName(ctx.currency);

    // The facts, from the same helpers the other engines use — so a shop
    // that delivers by area, or is shut, or knows this caller, is described
    // the same way whichever engine picks up.
    const areas = areaZoneNames(ctx.deliveryZones as any);
    const delivery = areas.length
      ? `- Delivery is by AREA here: ${areas.join(', ')}. Ask which area they're in and run check_delivery_area. Anywhere else, say plainly you don't deliver there and offer collection.`
      : postcodeRequiredFor(ctx.country)
        ? '- For delivery, get the postcode first and run check_delivery_area before the rest of the address.'
        : '- Addresses here have no postcodes. Take the building or street and the city.';
    const saved = state?.savedAddress;
    const returning = saved?.line1
      ? `
- You know this caller${state?.knownName ? ` — ${state.knownName}` : ''}. Their last delivery went to ${[saved.line1, saved.city, saved.postcode].filter(Boolean).join(', ')}. For delivery, don't take the address from scratch: ask "still at ${saved.line1}?" — a yes means use_saved_address, anything else means take a new one. Use their name at most twice.`
      : '';
    const open = ctx.openingHours
      ? isCurrentlyOpen(ctx.openingHours, ctx.timezone || 'Europe/London')
      : true;
    const closed = open
      ? ''
      : `

THE SHOP IS CLOSED RIGHT NOW
- Say so straight away, kindly, and say when it opens (get_opening_hours). Don't take an order. Offer to take a message with take_message, or transfer_to_staff if they want to book for later.`;
    const theUsual = usual
      ? `

THEY'VE ORDERED HERE BEFORE
- Their usual: "${usual}". Once they say they'd like to order, offer it once, naturally. If they say yes, call use_usual and then read_back_order. If not, forget it and take the order fresh.`
      : '';
    return this
      .cappedForRealtime(`You answer the phone at ${shop}. You take orders for collection and delivery, answer questions about the menu, and help with orders already placed. You sound like a friendly, quick person behind the counter — not a phone system.

HOW YOU TALK
- Short sentences. One question at a time. Warm, but brisk — people are hungry.
- Never tell anyone to press a number.
- Asked what you have, name two or three — short names, no descriptions — then ask what they fancy. Never read the whole list. Five parmas by full name was eleven seconds of a caller's life.
- If you didn't catch something, ask again for that ONE thing. Never ask them to repeat the whole order.
- Speak ${lang}, and only ${lang}, whatever language or accent the caller uses. Never switch.
- Say prices as words in ${currency} ("eight ${currency} fifty"), never as symbols.

TAKING THE ORDER
- Start by asking what they'd like. Whether it's collection or delivery, and the address, can come whenever it fits — before the read-back, not before the first item.
- When they list food, call parse_order with their exact words. It adds what it can and tells you what still needs a choice. For one item, add_item works the same way.
- Some things need a choice — size, crust, sauce. The tool tells you which; ask in your own words, then call add_item again with modifierNames.
- Only the menu below and what the tools return are real. Never invent a dish, a size or a price. If it isn't on the menu, say so and offer the closest thing that is.
- Quantities and notes ("no onions") go on the item. Allergies go in the notes AND you say you've noted it.

CHANGING THEIR MIND
- "I wanted one", "make it deep pan", "take the chips off", "start again" — use change_item, remove_item or clear_order, by the item's name or its line id from "Order so far". Never fix an order by adding to it, and never say you've started fresh unless you called clear_order.

BEFORE IT'S PLACED
- Call read_back_order and say the script it gives you word for word, then stop and wait.
- Only when the caller clearly agrees: call order_confirmed, ask cash or card, then place_order. If they change anything after the read-back, read it back again — a yes only counts for what they heard.
${delivery}
- Read a new address back once, then confirm_delivery_address. Only use an address on file after they've said yes to it.${returning}
- If they want a person, or press 0, transfer_to_staff. If something has gone wrong with an existing order, get_order_status or take_message.${theUsual}${closed}

MENU
${this.compactMenu(ctx)}
* needs a choice — add_item tells you which`);
  }

  /** The same tools, described for a model that asks rather than walks through. */
  toolsForConversation(ctx: VoiceContext): Array<Record<string, unknown>> {
    const base = this.toolsForRealtime(ctx).map((t) => {
      if (t.name === 'add_item') {
        return {
          ...t,
          description:
            "Add one item to the order. Pass `said` with the caller's own words for that item (quantity included). If the item needs a choice you haven't got yet — size, crust, sauce — this does NOT add it: it tells you exactly what is missing and the options, so you can ask. Then call it again with modifierNames. Notes like 'no onions' go in notes.",
          parameters: {
            ...(t.parameters as any),
            properties: {
              ...((t.parameters as any)?.properties ?? {}),
              modifierNames: {
                type: 'array',
                items: { type: 'string' },
                description:
                  "Choices by name, as the caller said them — e.g. ['12 inch', 'deep pan', 'garlic']. Matched against the item's option groups.",
              },
            },
          },
        };
      }
      if (t.name === 'remove_item') {
        return {
          ...t,
          description:
            "Take something off the order. Say which item as the caller did ('the pepperoni', 'the chips') — or pass its line id from 'Order so far'. quantity removes that many; leave it out to remove the whole line.",
          parameters: {
            type: 'object',
            properties: {
              said: { type: 'string', description: "Which item, in the caller's words" },
              lineId: { type: 'string', description: "The line id shown in 'Order so far'" },
              quantity: {
                type: 'integer',
                minimum: 1,
                description: 'How many to take off; omit for all',
              },
            },
          },
        };
      }
      return t;
    });
    base.push({
      type: 'function',
      name: 'change_item',
      description:
        "Change something already on the order: how many ('I wanted one'), a choice ('make it deep pan'), or a note. Say which item as the caller did, or pass its line id. Use this instead of removing and re-adding.",
      parameters: {
        type: 'object',
        properties: {
          said: { type: 'string', description: "Which item, in the caller's words" },
          lineId: { type: 'string' },
          quantity: { type: 'integer', minimum: 1 },
          modifierNames: {
            type: 'array',
            items: { type: 'string' },
            description: 'New choices by name, e.g. ["deep pan"]',
          },
          notes: { type: 'string' },
        },
      },
    });
    base.push({
      type: 'function',
      name: 'clear_order',
      description:
        'The caller wants to start the order again from nothing. Empties it. Only call this when they have said so.',
      parameters: { type: 'object', properties: {} },
    });
    base.push({
      type: 'function',
      name: 'parse_order',
      description:
        'The caller listed food — possibly several things, with sizes, choices, quantities or notes in one breath. Pass their exact words. Everything that can be resolved is added to the order; anything that still needs a choice is returned for you to ask about. Use this instead of guessing item ids.',
      parameters: {
        type: 'object',
        properties: {
          said: { type: 'string', description: "The caller's exact words for the food they want" },
        },
        required: ['said'],
      },
    });
    return base;
  }

  /**
   * The conversation engine's executor.
   *
   * add_item never opens a walkthrough here — it adds, or says what it
   * needs. parse_order puts Claude behind the counter for a sentence with
   * several things in it. The three tools that turn a yes into food take the
   * model's word for the yes: it heard the caller, and nothing on this line
   * hears them better. Every rule that does not depend on hearing still runs
   * underneath, in the same code the other engines use.
   */
  async runToolForConversation(
    name: string,
    input: any,
    ctx: VoiceContext,
    state: VoiceState,
    callerNumber?: string | null,
  ): Promise<{ result: string; turn?: Partial<VoiceTurn>; sayNow?: string }> {
    switch (name) {
      case 'add_item':
        return this.addItemConversational(input, ctx, state);
      case 'parse_order':
        return this.parseOrder(String(input?.said ?? ''), ctx, state);
      case 'place_order': {
        // The payment answer is a caller turn. No turn since the question,
        // no order — whatever the model believes it heard.
        if (input?.__spokeAfterQuestion !== true) {
          return {
            result:
              "Not placed — the caller hasn't answered since you asked. Ask how they'd like to pay and WAIT for them to speak.",
          };
        }
        return this.runTool(name, input, ctx, state, callerNumber);
      }
      case 'remove_item':
        return this.removeItemConversational(input, ctx, state);
      case 'change_item':
        return this.changeItemConversational(input, ctx, state);
      case 'clear_order':
        state.cart.items = [];
        this.forgetConfirmation(state);
        return { result: 'The order is empty. Ask what they would like.' };
      case 'use_saved_address':
      case 'confirm_delivery_address':
      case 'order_confirmed': {
        // The model's word is the consent. The fingerprint rules inside
        // still refuse a stale yes, a changed basket, or an unread order.
        // No word is put in the caller's mouth. The gateway says whether a
        // caller turn happened after the question; agreed() decides on that.
        (state as any).__conversation = true;
        try {
          return await this.runTool(
            name,
            { ...input, __conversation: true },
            ctx,
            state,
            callerNumber,
          );
        } finally {
          delete (state as any).__conversation;
        }
      }
      default:
        return this.runTool(name, input, ctx, state, callerNumber);
    }
  }

  /**
   * Every choice the caller has made about a dish, from ids, names, or their
   * own words. Shared by add_item and change_item so "make it deep pan" is
   * resolved exactly the way "deep pan" was when the pizza went on.
   */
  private chooseOptions(item: any, input: any, chosen: Set<string>): Set<string> {
    const groups: any[] = item.modifierGroups ?? [];
    const has = (g: any) => g.options.filter((o: any) => chosen.has(o.id)).length;
    for (const id of Array.isArray(input?.modifierOptionIds) ? input.modifierOptionIds : []) {
      if (groups.some((g) => g.options.some((o: any) => o.id === String(id))))
        chosen.add(String(id));
    }
    for (const raw of Array.isArray(input?.modifierNames) ? input.modifierNames : []) {
      const name = String(raw ?? '').trim();
      if (!name) continue;
      for (const g of groups) {
        const hit = matchOption<any>(name, g.options, g.name);
        if (!hit) continue;
        // A new choice in a single-choice group replaces the old one:
        // "make it deep pan" is not "deep pan as well as thin".
        if (needed(g) <= 1) for (const o of g.options) chosen.delete(o.id);
        chosen.add(hit.item.id);
        break;
      }
    }
    // Their own words, for required groups only — "12 inch pepperoni, deep
    // pan" settles the crust without the model restating it. Never for an
    // optional group: "pepperoni" must not add a paid pepperoni topping.
    // "Twelve inch pepperoni, deep pan, chips and garlic sauce": the crust
    // belongs to the pizza even though the segmenter filed it three words
    // away. choicesFrom is the whole sentence; said is only the words that
    // named the dish.
    // Word for word, not by sound: fuzzily, "ten inch" chose Thin. Of the
    // options they named, the most specific one — "deep pan" over "pan".
    const said = String(input?.choicesFrom ?? input?.said ?? '');
    if (said) {
      for (const g of groups) {
        if (!mustChoose(g) || has(g) >= needed(g)) continue;
        const named = g.options
          .filter((o: any) => saysOption(said, String(o.name)))
          .sort((a: any, b: any) => String(b.name).length - String(a.name).length);
        if (named.length) chosen.add(named[0]!.id);
      }
    }
    return chosen;
  }

  /** The order as the model should see it: with the ids it needs to change it. */
  private cartForModel(state: VoiceState, ctx: VoiceContext): string {
    const lines = state.cart.items.map((l: any) => {
      const mods = (l.modifiers ?? []).map((m: any) => m.name).join(', ');
      const unit =
        Number(l.unitBasePrice ?? 0) +
        (l.modifiers ?? []).reduce((a: number, m: any) => a + Number(m.price ?? 0), 0);
      return `- [line ${l.lineId}] ${l.quantity}× ${l.name}${mods ? ` (${mods})` : ''}${l.notes ? ` — note: ${l.notes}` : ''} — ${money(unit * l.quantity, ctx.currency)}`;
    });
    const subtotal = state.cart.items.reduce((a: number, l: any) => {
      const unit =
        Number(l.unitBasePrice ?? 0) +
        (l.modifiers ?? []).reduce((x: number, m: any) => x + Number(m.price ?? 0), 0);
      return a + unit * l.quantity;
    }, 0);
    return lines.length
      ? `${lines.join('\n')}\nSubtotal: ${money(subtotal, ctx.currency)}`
      : '(empty)';
  }

  /** Which line they mean: by id, or by the words they used for it. */
  private findLine(input: any, state: VoiceState): { line?: any; result?: string } {
    const items: any[] = state.cart.items;
    if (!items.length) return { result: 'There is nothing on the order yet.' };
    const byId = items.find((l) => l.lineId === String(input?.lineId ?? ''));
    if (byId) return { line: byId };
    const norm = (t: string) =>
      String(t ?? '')
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    const said = norm(input?.said ?? '');
    if (!said)
      return {
        result: `Say which item. The order is:\n${items.map((l) => `- [line ${l.lineId}] ${l.quantity}× ${l.name}`).join('\n')}`,
      };
    const words = said
      .split(' ')
      .filter(
        (w) =>
          w.length > 2 && !['the', 'one', 'two', 'that', 'those', 'pizza', 'pizzas'].includes(w),
      );
    const scored = items
      .map((l) => {
        const hay = norm(`${l.name} ${(l.modifiers ?? []).map((m: any) => m.name).join(' ')}`);
        // "the pepperonis" is the pepperoni; "chips" is not "chip" + s only
        // in a menu. Singular and plural both count.
        const score = words.filter(
          (w) => hay.includes(w) || hay.includes(w.replace(/s$/, '')) || hay.includes(`${w}s`),
        ).length;
        return { l, score };
      })
      .sort((a, b) => b.score - a.score);
    const [best, second] = scored;
    if (!best || best.score === 0) {
      return {
        result: `Nothing on the order matches "${input?.said}". The order is:\n${items.map((l) => `- [line ${l.lineId}] ${l.quantity}× ${l.name}`).join('\n')}`,
      };
    }
    if (second && second.score === best.score) {
      return {
        result: `Could be more than one line. Ask which, or pass the line id:\n${scored
          .filter((x) => x.score === best.score)
          .map(
            ({ l }) =>
              `- [line ${l.lineId}] ${l.quantity}× ${l.name}${(l.modifiers ?? []).length ? ` (${l.modifiers.map((m: any) => m.name).join(', ')})` : ''}`,
          )
          .join('\n')}`,
      };
    }
    return { line: best.l };
  }

  private forgetConfirmation(state: VoiceState): void {
    state.orderConfirmed = false;
    state.orderConfirmedOf = undefined;
  }

  /** "Take the chips off" / "just one of those". */
  private removeItemConversational(
    input: any,
    ctx: VoiceContext,
    state: VoiceState,
  ): { result: string } {
    const { line, result } = this.findLine(input, state);
    if (!line) return { result: result! };
    const n = Number(input?.quantity);
    if (Number.isInteger(n) && n > 0 && n < line.quantity) {
      line.quantity -= n;
      this.forgetConfirmation(state);
      return {
        result: `Took ${n} off — now ${line.quantity}× ${line.name}.\nOrder so far:\n${this.cartForModel(state, ctx)}`,
      };
    }
    state.cart.items = state.cart.items.filter((l: any) => l.lineId !== line.lineId);
    this.forgetConfirmation(state);
    return {
      result: `Removed ${line.quantity}× ${line.name}.\nOrder so far:\n${this.cartForModel(state, ctx)}`,
    };
  }

  /** "I wanted one" / "make it deep pan" / "no onions on that". */
  private changeItemConversational(
    input: any,
    ctx: VoiceContext,
    state: VoiceState,
  ): { result: string } {
    const { line, result } = this.findLine(input, state);
    if (!line) return { result: result! };
    const changed: string[] = [];
    const q = Number(input?.quantity);
    if (Number.isInteger(q) && q > 0 && q !== line.quantity) {
      line.quantity = q;
      changed.push(`quantity ${q}`);
    }
    if (Array.isArray(input?.modifierNames) && input.modifierNames.length) {
      const item = ctx.itemIndex.get(line.itemId);
      if (item) {
        const chosen = this.chooseOptions(
          item,
          { modifierNames: input.modifierNames },
          new Set((line.modifiers ?? []).map((m: any) => m.optionId)),
        );
        const groups: any[] = item.modifierGroups ?? [];
        const missing = groups.filter(
          (g) => mustChoose(g) && g.options.filter((o: any) => chosen.has(o.id)).length < needed(g),
        );
        if (missing.length) {
          return {
            result: `That change would leave the ${line.name} without a ${this.groupLabel(missing[0].name)}. Ask which they want.`,
          };
        }
        line.modifiers = [...chosen]
          .map((id) => ctx.optionIndex.get(id))
          .filter(Boolean)
          .map((m: any) => ({ optionId: m.option.id, name: m.option.name, price: m.option.price }));
        changed.push(`choices ${line.modifiers.map((m: any) => m.name).join(', ')}`);
      }
    }
    if (typeof input?.notes === 'string') {
      line.notes = input.notes.trim().slice(0, 200) || undefined;
      changed.push(line.notes ? `note "${line.notes}"` : 'note removed');
    }
    if (!changed.length)
      return { result: `Nothing to change — say what should be different about the ${line.name}.` };
    this.forgetConfirmation(state);
    return {
      result: `Changed ${line.name}: ${changed.join('; ')}.\nOrder so far:\n${this.cartForModel(state, ctx)}`,
    };
  }

  /** Which dish they mean, from an id or their words. Mirrors add_item's opening. */
  private resolveDish(
    input: any,
    ctx: VoiceContext,
  ): { item?: any; quantity: number; result?: string } {
    const explicit = ctx.itemIndex.get(String(input?.itemId ?? ''));
    const said = String(input?.said ?? '').trim();
    const { quantity: spokenQty, rest } = said
      ? splitQuantity(said)
      : { quantity: undefined, rest: '' };
    const quantity = Math.max(1, Math.round(Number(input?.quantity) || spokenQty || 1));
    if (explicit) return { item: explicit, quantity };
    if (!said) return { quantity, result: "Say which item — pass `said` with the caller's words." };

    const matches = matchItemGroups(rest || said, ctx.items, { limit: 3 });
    if (!matches.length) {
      return {
        quantity,
        result: `Nothing on the menu matches "${said}". Tell them plainly you don't have it and offer the closest thing you do.`,
      };
    }
    if (!isConfidentGroup(matches)) {
      return {
        quantity,
        result: `Could be ${matches.map((m) => m.group.base).join(' or ')}. Ask which they meant.`,
      };
    }
    const { group } = matches[0]!;
    if (group.variants.length === 1) return { item: group.variants[0]!, quantity };
    const chosen = pickVariant(said, group.variants);
    if (chosen) return { item: chosen, quantity };
    return {
      quantity,
      result: `${group.base} comes in more than one size — ${sizesAloud(group.variants)}. Ask which, then add it.`,
    };
  }

  /**
   * add_item without the walkthrough.
   *
   * Everything the caller has said about the dish is taken: option ids, names
   * ("deep pan"), and anything in their own words that names a required
   * choice. If something required is still missing, nothing is added and the
   * model is told exactly what to ask. If it is all there, it goes in.
   */
  addItemConversational(input: any, ctx: VoiceContext, state: VoiceState): { result: string } {
    const { item, quantity, result } = this.resolveDish(input, ctx);
    if (!item) return { result: result ?? "That item isn't on the menu." };

    const groups: any[] = item.modifierGroups ?? [];
    const chosen = this.chooseOptions(item, input, new Set<string>());
    const has = (g: any) => g.options.filter((o: any) => chosen.has(o.id)).length;
    const missing = groups.filter((g) => mustChoose(g) && has(g) < needed(g));
    if (missing.length) {
      const { base } = splitSize(item.name);
      const asks = missing.map((g) => {
        const opts = g.options.slice(0, 8).map((o: any) => this.spokenSize(o.name));
        return `${this.groupLabel(g.name)} (${opts.join(', ')}${g.options.length > 8 ? ', …' : ''})`;
      });
      return {
        result: `NOT added yet. The ${base} still needs a choice of: ${asks.join('; ')}. Ask the caller in your own words — one question — then call add_item again with modifierNames.`,
      };
    }

    const modifiers = [...chosen]
      .map((id) => ctx.optionIndex.get(id))
      .filter(Boolean)
      .map((m: any) => ({ optionId: m.option.id, name: m.option.name, price: m.option.price }));
    const notes = String(input?.notes ?? '')
      .trim()
      .slice(0, 200);
    // The same line, seconds apart, from two different tool calls is one
    // order, not two: parse_order took 2.7s, the caller spoke again, and
    // the model — prompted by the new turn — added the pizza a second time.
    const recent = (state as any).__lastAdd as { key: string; at: number } | undefined;
    const key = `${item.id}|${[...chosen].sort().join(',')}|${notes}`;
    if (recent && recent.key === key && Date.now() - recent.at < 8000) {
      return {
        result: `Already on the order — that ${item.name} was added a moment ago. Not adding it again.\nOrder so far:\n${this.cartForModel(state, ctx)}`,
      };
    }
    (state as any).__lastAdd = { key, at: Date.now() };
    state.cart.items.push({
      lineId: Math.random().toString(36).slice(2, 9),
      itemId: item.id,
      name: item.name,
      quantity,
      unitBasePrice: item.price,
      modifiers,
      ...(notes ? { notes } : {}),
    } as any);
    // Anything confirmed before this is about a different order now.
    state.orderConfirmed = false;
    state.orderConfirmedOf = undefined;

    const withOpts = modifiers.length ? ` with ${modifiers.map((m) => m.name).join(', ')}` : '';
    return {
      result: `Added ${quantity} × ${item.name}${withOpts}${notes ? ` (note: ${notes})` : ''}.\nOrder so far:\n${this.cartForModel(state, ctx)}`,
    };
  }

  /**
   * A sentence with several things in it, understood by Claude.
   *
   * gpt-realtime hears best; Claude reads best. "Two large pepperonis, one
   * with no cheese, and put that on the deal" is the second job. Claude gets
   * the compact menu and the sentence and returns the items as structured
   * calls, which then go through exactly the same add_item as anything else —
   * so a required choice it could not settle is still asked for, not guessed.
   * Without a Claude key the matcher's own segmentation does the job.
   */
  private async parseOrder(
    said: string,
    ctx: VoiceContext,
    state: VoiceState,
  ): Promise<{ result: string }> {
    const text = said.trim();
    if (!text) return { result: "Nothing to parse — pass the caller's words." };

    type Parsed = {
      itemId?: string;
      said?: string;
      choicesFrom?: string;
      quantity?: number;
      modifierNames?: string[];
      notes?: string;
    };

    // The matcher first. "Twelve inch pepperoni, deep pan, chips and garlic
    // sauce" is exactly what it was built for, it answers in a millisecond,
    // and it does not invent — Claude, given the whole menu and asked to
    // read that sentence, returned "garlic sauce, note: chips". Claude is
    // for the words the matcher could not place, and only those.
    const { found, leftovers } = segmentItems(text, ctx.items, { limit: 3 });
    // Each dish is offered its own words and the ones that followed it, not
    // the whole sentence: read the sentence, "Thin" scored as well as "Deep
    // Pan" for the 12-inch because of the "ten inch" three items later, and
    // the crust that had been said plainly was asked for again.
    const parsed: Parsed[] = found.map((f) => ({
      said: f.phrase,
      choicesFrom: `${f.phrase} ${f.trailing}`.trim(),
      quantity: f.quantity,
      itemId: f.match.group.variants.length === 1 ? f.match.group.variants[0]!.id : undefined,
    }));
    // Words the segmenter left over that are the NAME of a choice on one of
    // the dishes it found ("deep pan") are that choice, not a missing item —
    // they are absorbed below and must not be sent to Claude to guess at.
    const optionWords = new Set<string>();
    for (const f of found)
      for (const v of f.match.group.variants)
        for (const g of (v as any).modifierGroups ?? [])
          for (const o of g.options ?? [])
            for (const w of String(o.name).toLowerCase().split(/[^a-z0-9]+/)) if (w) optionWords.add(w);
    const unplaced = leftovers
      .map((l) => l.split(/\s+/).filter((w) => !optionWords.has(w.toLowerCase().replace(/[^a-z0-9]/g, ''))).join(' '))
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (unplaced && this.anthropic) {
      try {
        const res = await this.anthropic.messages.create({
          model: this.parseModel ?? this.model,
          max_tokens: 400,
          system:
            'You turn what a takeaway customer said on the phone into order lines. Use ONLY the menu given. Return JSON only: an array of {"itemId": string (from the menu), "quantity": number, "modifierNames": string[] (sizes, crusts, sauces, choices exactly as said), "notes": string}. Never invent items; never turn one item into another with a note. If a phrase matches nothing, omit it. No prose.',
          messages: [
            {
              role: 'user',
              content: `MENU (each line: id | name | price)\n${(ctx.items ?? [])
                .map((i: any) => `${i.id} | ${i.name} | ${money(i.price, ctx.currency)}`)
                .join('\n')}\n\nCUSTOMER SAID: "${unplaced}"`,
            },
          ],
        });
        const raw = res.content.filter((b): b is Anthropic.TextBlock => b.type === 'text').map((b) => b.text).join('');
        const json = raw.slice(raw.indexOf('['), raw.lastIndexOf(']') + 1);
        const arr = JSON.parse(json);
        if (Array.isArray(arr)) for (const p of arr) parsed.push(p);
      } catch (e: any) {
        this.logger.warn(`parse_order via Claude failed: ${e?.message ?? e} — matcher only`);
      }
    }
    if (!parsed.length) {
      return { result: `Couldn't match "${text}" to the menu. Ask what they'd like, one item at a time.` };
    }

    const added: string[] = [];
    const asks: string[] = [];
    for (const p of parsed) {
      const out = this.addItemConversational(
        {
          itemId: p.itemId,
          said: p.said ?? text,
          choicesFrom: p.choicesFrom ?? p.said ?? text,
          quantity: p.quantity,
          modifierNames: p.modifierNames,
          notes: p.notes,
        },
        ctx,
        state,
      );
      // Anything that is not an "Added" is something still to settle — a
      // missing choice, a size, a name that fits two dishes. It was filed as
      // added if it did not begin "NOT added", and "Pepperoni comes in more
      // than one size" read as good news.
      (out.result.startsWith('Added') ? added : asks).push(out.result.split('\n')[0]!);
    }
    const summary = state.cart.items.length ? `\nOrder so far:\n${this.cartForModel(state, ctx)}` : '';
    return {
      result:
        `${added.length ? added.join(' ') : 'Nothing added yet.'}` +
        `${asks.length ? `\nStill to ask: ${asks.join(' ')}` : ''}${summary}` +
        `${unplaced && !this.anthropic ? `\nCould not place: "${unplaced}".` : ''}`,
    };
  }

  // ── The speech-to-speech engine's view of the same brain ────────────────
  //
  // Three thin adapters. They exist so the second engine cannot quietly grow
  // its own rules: it gets this prompt, these tools and this executor, and
  // every guard they contain applies to it exactly as written.

  /** The system prompt, plus what a voice-only model needs told differently. */
  /**
   * The same instructions, without the menu in them.
   *
   * Every item, size and option of a 150-item menu is four times what the
   * realtime API will accept in one instruction block. The tools already do
   * the looking up, so the model is told what the shop sells in categories and
   * pointed at find_item for anything specific.
   */
  private briefPrompt(ctx: VoiceContext, state?: VoiceState): string {
    const categories = [...new Set(ctx.items.map((i: any) => i.categoryName).filter(Boolean))];
    // Everything except the menu, which is the last block of the prompt.
    // Keeping ONE source for the rules matters more than the line of stitching
    // it costs: a second copy of them would drift within a week.
    const full = this.systemPrompt(ctx, state, { menu: 'full' });
    const withoutMenu = full.split('\nMENU\n')[0] ?? full;
    return `${withoutMenu}

THE MENU IS NOT IN FRONT OF YOU
- ${ctx.items.length} items across: ${categories.join(', ') || 'one list'}.
- You cannot see the dishes or the prices. Do NOT invent, guess or describe
  one, and never say a price you have not been given.
- To find anything, call find_item with the caller's OWN words — it searches
  the whole menu and tells you exactly what matched, what it costs, and what
  still has to be chosen about it. add_item does the same and adds it.
- Asked what the shop does, name the categories above and offer to look
  something up. Asked for something specific, look it up.`;
  }

  /**
   * Instructions the realtime API will actually accept.
   *
   * Capped, and loudly, because the failure mode is invisible from the
   * caller's end: the session is refused, nothing is spoken, and they sit in
   * silence until the call is handed to the other engine. A shop with a bigger
   * menu than the one that caught this must not rediscover it on a Friday
   * night. Roughly four characters to a token, against a 16,384 limit.
   */
  private cappedForRealtime(text: string): string {
    const limit = 14_000 * 4;
    if (text.length <= limit) return text;
    this.logger.error(
      `realtime instructions too long (${text.length} chars) — trimming. Something has been added to the prompt that does not belong in it.`,
    );
    return `${text.slice(0, limit)}\n\n[instructions truncated]`;
  }

  promptForRealtime(ctx: VoiceContext, state: VoiceState, usual?: string | null): string {
    // A regular who rings back gets the same one-question call whichever
    // engine answered. Said EXACTLY as written, because the whole value of it
    // is that a yes cannot be misheard — a paraphrase invites a conversation.
    const theUsual = usual
      ? `

THEY HAVE ORDERED HERE BEFORE
- Once they have said they want to order, your FIRST question is this, word for
  word: "${usual}"
- If they say yes, call use_usual and then read_back_order. Do not ask them
  anything else first — not collection or delivery, not the address. It is all
  on the order already.
- If they say no, or change any part of it, forget it entirely and take the
  order from the beginning: "No problem — is that collection or delivery?"`
      : '';
    return this.cappedForRealtime(`${this.systemPrompt(ctx, state, { menu: 'brief' })}${theUsual}

YOU ARE SPEAKING, NOT WRITING
- Everything you produce is heard aloud. Never say a bullet, a heading, an
  emoji, a price written as "£8.00" (say "eight pounds"), or a menu name in
  brackets — "Margherita (14 inch)" is said "Margherita, fourteen inch".
- Short turns. A caller cannot skim.
- If you did not hear something, ask for that one thing again. Never ask them
  to repeat a whole order.
- You hear the caller's actual voice, which is the one thing you can do that
  the other engine cannot. Use it: an unclear word in the middle of a familiar
  dish is nearly always that dish. But CHECK by reading it back, never by
  assuming.

NO MEANS NO
- If you ask "are you still at <address>?" and they say no, or anything that
  is not a yes, you must NOT call use_saved_address. They have just told you
  they are somewhere else. Ask "No problem — what's the delivery address?" and
  take the new one.
- The same applies to every read-back. A no is never a reason to proceed with
  what you already had; it is the caller correcting you, and proceeding anyway
  sends a driver to the wrong house.
- If you did not catch whether it was a yes or a no, ask again. Guessing yes
  is the one guess you can never make.
- Silence is not an answer, and neither is a noise. If the caller has not
  actually said words, they have not replied — wait, and ask again if you must.
  Never fill in what you assume they meant. On a live call a breath was taken
  for a "no" and an order was started over that the caller had not asked for.

THE ADDRESS CAN BE CHANGED AT ANY POINT
- "That address is wrong", "I've moved", "I want to change my address", "it's
  going somewhere else" — at ANY moment in the call, including in the middle of
  ordering food and including after you have already read the address back.
- That is never a menu item. Do not search for it, do not offer them a drink.
  Say "No problem — what's the new address?" and take it with
  propose_delivery_address, exactly as you would have at the start.
- A caller who has said it twice is a caller you have not listened to. Stop
  whatever else you were doing and take the address.`);
  }

  /** Our tools, in the shape the realtime API wants them. */
  toolsForRealtime(ctx: VoiceContext): Array<Record<string, unknown>> {
    return this.toolDefs(ctx).map((t) => ({
      type: 'function',
      name: t.name,
      description: t.description,
      parameters: t.input_schema,
    }));
  }

  /** The same executor, and therefore the same refusals. */
  async runToolForRealtime(
    name: string,
    input: any,
    ctx: VoiceContext,
    state: VoiceState,
    callerNumber?: string | null,
  ): Promise<{ result: string; turn?: Partial<VoiceTurn> }> {
    return this.runTool(name, input, ctx, state, callerNumber);
  }

  /** What could the caller have meant? Offered to the model before it commits. */
  private findItem(said: string, ctx: VoiceContext): string {
    const { rest } = splitQuantity(said);
    const matches = matchItemGroups(rest || said, ctx.items, { limit: 4 });
    if (!matches.length) {
      return `Nothing on the menu matches "${said}". Tell them plainly that you don't have it and offer the closest thing you DO have.`;
    }
    if (isConfidentGroup(matches)) {
      const { group } = matches[0]!;
      const chosen =
        pickVariant(said, group.variants) ??
        (group.variants.length === 1 ? group.variants[0]! : null);
      if (chosen) return `That's ${chosen.name} [${chosen.id}]. Add it with add_item.`;
      // The dish is certain and only the size is open. Asking "which one" and
      // reading three near-identical names is the wrong question.
      return `That's ${group.base}, but it comes in more than one size. Ask: "What size ${group.base} — ${sizesAloud(group.variants)}?"`;
    }
    return `Not sure between: ${matches
      .map((m) => m.group.base)
      .join(', ')}. Ask the caller which one — do not choose for them.`;
  }

  private addItem(
    input: any,
    ctx: VoiceContext,
    state: VoiceState,
  ): { result: string; sayNow?: string } {
    // The caller's own words are the better input. A transcriber that has
    // never seen this menu turns "three cola" into "Drie coli", and asking a
    // model to pick an exact id out of that leaves it guessing or asking
    // again — one puts the wrong food in the kitchen, the other is what makes
    // a four-item order take two minutes.
    let item = ctx.itemIndex.get(String(input?.itemId ?? ''));
    let quantityFromSpeech: number | undefined;

    if (!item && input?.said) {
      const said = String(input.said);
      const { quantity, rest } = splitQuantity(said);
      quantityFromSpeech = quantity;
      // Dishes, not sizes. Scoring the caller's words against "Margherita
      // (10\")" put every sized item permanently below the confidence bar AND
      // tied it with its own siblings, so a plainly-said "large margherita"
      // could only ever come back as a question.
      const matches = matchItemGroups(rest, ctx.items, { limit: 3 });
      if (!matches.length) {
        return {
          result: `Nothing on the menu matches "${said}". Say plainly that you don't have it, and offer the closest thing you do.`,
        };
      }
      if (!isConfidentGroup(matches)) {
        // Two plausible dishes is a question for the caller, not a coin toss
        // on their behalf — and getting it wrong here is a wrong meal cooked.
        return {
          result: `More than one thing matches "${said}": ${matches
            .map((m) => m.group.base)
            .join(' or ')}. Ask which one they meant, then add it.`,
        };
      }

      const { group } = matches[0]!;
      if (group.variants.length === 1) {
        item = group.variants[0]!;
      } else {
        // "a large margherita" already answered this; only ask when it didn't.
        const chosen = pickVariant(said, group.variants);
        if (!chosen) {
          return {
            result: `${group.base} comes in more than one size and they haven't said which. Ask: "What size ${group.base} — ${sizesAloud(group.variants)}?" Then add it.`,
          };
        }
        item = chosen;
      }
    }

    if (!item) {
      return {
        result: "That item isn't on the menu — tell the caller and suggest something similar.",
      };
    }

    const chosenIds: string[] = Array.isArray(input?.modifierOptionIds)
      ? input.modifierOptionIds.map(String)
      : [];

    // A required group that was never asked about is the classic way an order
    // reaches the kitchen wrong — so the walkthrough takes over here, exactly
    // as it does when the matcher added the dish itself.
    //
    // Telling the MODEL to ask was the old answer, and it is why the numbers
    // came and went on a real call: "solo meal" was matched in code and got
    // "press 1 for Gyros Wrap, 2 for…", while the same dish reached by any
    // phrasing the matcher was less sure of went to the model, which asked in
    // its own words. Same dish, same question, two different lines — and on
    // the model's version the keypad did nothing, because nothing had recorded
    // what 1 and 2 meant.
    const needsChoice = (item.modifierGroups ?? []).some((g: any) => {
      if (!mustChoose(g)) return false;
      const picked = g.options.filter((o: any) => chosenIds.includes(o.id));
      return picked.length < needed(g);
    });
    // A walkthrough already running is not restarted.
    //
    // This is the loop. The caller pressed 2, the keypad handler took it and
    // moved on to the note question — and six hundred milliseconds later the
    // model called add_item again, which built a brand new pendingItem, threw
    // away the size that had just been chosen, and asked for it again. Every
    // press worked. Every press was undone.
    //
    // Whatever the model believes, an item mid-walkthrough is being handled
    // somewhere it cannot see.
    // Keyed on the walkthrough being open, not on what the model passed. A
    // re-add that happens to carry the choices does not restart anything — it
    // adds a second line and leaves the half-answered one open behind it, so
    // the next keypress commits a duplicate.
    if (state.pendingItem?.itemId === item.id && state.pendingItem.walked) {
      const outstanding = this.askNextOption(ctx, state);
      // Never claim it is in the basket. It is NOT — it sits in pendingItem
      // until the last question about it is answered, and saying otherwise is
      // how a pizza went missing from an order that had already been read
      // back as containing one.
      return {
        result: outstanding
          ? `You have ALREADY asked them this and their answer is being handled in code. Do not call add_item again for the ${item.name}. Say nothing and wait.`
          : `The ${item.name} is mid-order and NOT in the basket yet — they are being asked whether they want any notes on it, and that answer is handled in code. Do not call add_item again for it, and do not read the order back until it lands.`,
      };
    }

    if (needsChoice) {
      state.pendingItem = {
        itemId: item.id,
        quantity: Math.max(1, Math.round(Number(input?.quantity) || quantityFromSpeech || 1)),
        chosen: chosenIds,
        ...(input?.notes ? { notes: String(input.notes), notesAsked: true } : {}),
      };
      // A deal is several choices at once. Saying what it comes with and
      // inviting all of them in one breath is how a person takes "meal deal
      // 2" — then only what is still missing gets asked for.
      const required = (item.modifierGroups ?? []).filter((g: any) => mustChoose(g));
      // Three or more, not two: a pizza with a size and a crust is two plain
      // questions, and asking for "your choices" about it sounds like a form.
      // A deal — pizza, kebab, chips, drinks — is where saying it all in one
      // breath is what a person would do.
      if (required.length >= 3 && chosenIds.length === 0) {
        state.pendingItem.overview = true;
        state.pendingItem.walked = true;
        state.choices = undefined;
        const { base } = splitSize(item.name);
        const parts = this.spokenList(
          required.map((g: any) => this.groupLabel(g.name)),
          'and',
        );
        const say = `${base} comes with ${parts}. Tell me your choices and I'll add them for you.`;
        return {
          sayNow: say,
          result: `Asking them: "${say}" — their answer is being handled in code, so say nothing more.`,
        };
      }
      const ask = this.askNextOption(ctx, state);
      if (ask) {
        return {
          // Said verbatim rather than handed back for the model to paraphrase:
          // the numbers only work if the words the caller hears are the words
          // that were recorded against them.
          sayNow: ask.say,
          result: `Asking them: "${ask.say}" — their answer is being handled in code, so say nothing more.`,
        };
      }
      // No question could be built, which should not happen — but adding a
      // dish whose required choices are unanswered puts the wrong food in the
      // kitchen, so refuse the way this always has rather than guessing.
      state.pendingItem = undefined;
      const missing = (item.modifierGroups ?? []).find((g: any) => mustChoose(g));
      return {
        result: `Before adding this you must ask which ${missing?.name ?? 'option'} they want. Options: ${(
          missing?.options ?? []
        )
          .map((o: any) => o.name)
          .join(', ')}.`,
      };
    }

    const modifiers = chosenIds
      .map((id) => ctx.optionIndex.get(id))
      .filter(Boolean)
      .map((m: any) => ({ optionId: m.option.id, name: m.option.name, price: m.option.price }));

    const line = {
      lineId: Math.random().toString(36).slice(2, 9),
      itemId: item.id,
      name: item.name,
      quantity: Math.max(1, Math.round(Number(input?.quantity) || quantityFromSpeech || 1)),
      unitBasePrice: item.price,
      modifiers,
      notes: input?.notes ? String(input.notes) : undefined,
    };
    state.cart.items.push(line);
    return {
      result: `Added ${line.quantity} × ${item.name} at ${money(
        lineUnitPrice(line),
        ctx.currency,
      )} each.\nOrder so far:\n${summarizeCart(state.cart, ctx.currency)}`,
    };
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
    if (!addr) return '';
    const parts = [addr.line1, addr.city, addr.area].filter(Boolean);
    const pc = String(addr.postcode ?? '').trim();
    if (pc)
      parts.push(
        pc
          .toUpperCase()
          .split('')
          .join(' ')
          .replace(/\s{2,}/g, ', '),
      );
    return parts.join(', ');
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
  /**
   * The read-back, as a turn. Same words the model's tool speaks, so a caller
   * who took their usual hears exactly what a caller who ordered item by item
   * hears — including the price, which is the part they have not heard yet.
   */
  readBackAloud(
    ctx: VoiceContext,
    state: VoiceState,
  ): { say: string; next: VoiceState['awaiting'] } {
    state.orderConfirmed = false;
    return { say: this.readBackScript(ctx, state), next: 'ORDER_CONFIRM' };
  }

  private readBackScript(ctx: VoiceContext, state: VoiceState): string {
    const lines = state.cart.items
      .map((l) => {
        const mods = l.modifiers.length
          ? ` with ${l.modifiers.map((m) => m.name).join(' and ')}`
          : '';
        const qty = l.quantity > 1 ? `${l.quantity} ` : '';
        return `${qty}${l.name}${mods}${l.notes ? `, ${l.notes}` : ''}`;
      })
      .join(', then ');

    const isDelivery = state.cart.fulfillmentType === 'DELIVERY';
    const subtotal = cartSubtotal(state.cart);
    const fee = isDelivery ? this.feeForAddress(state.cart.deliveryAddress, ctx) : 0;
    const feeLine = fee > 0 ? ` plus ${money(fee, ctx.currency)} delivery` : '';
    const where = isDelivery
      ? `for delivery to ${this.spokenAddress(state.cart.deliveryAddress)}`
      : 'for collection';

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
    const asked = (where ?? '').trim();
    if (!asked) {
      return mode === 'AREA' ? 'Ask them which area they are in.' : 'Ask them for the postcode.';
    }
    const match = resolveZone(ctx.deliveryZones as any, {
      postcode: mode === 'AREA' ? undefined : asked,
      area: mode === 'AREA' ? asked : undefined,
    });
    if (!match.matched) {
      return `The shop does NOT deliver to ${asked}. Tell them, and offer collection instead.`;
    }
    return `Delivers to ${match.label ?? asked}. Fee ${money(match.fee, ctx.currency)}${
      match.minOrderValue ? `, minimum order ${money(match.minOrderValue, ctx.currency)}` : ''
    }.`;
  }

  private openingHours(ctx: VoiceContext): string {
    const oh = ctx.openingHours as any;
    if (!oh || typeof oh !== 'object') {
      return "Opening hours aren't recorded — offer to take a message or transfer.";
    }
    const days = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
    const parts = days
      .map((d) => {
        const v = oh[d];
        if (!v || v.closed) return `${d}: closed`;
        return `${d}: ${v.open ?? '?'}–${v.close ?? '?'}`;
      })
      .join('; ');
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
      const n = Number(String(orderNumber).replace(/\D/g, ''));
      if (!Number.isSafeInteger(n) || n <= 0) {
        return "That isn't a number I can look up. Ask them to read it out again, digit by digit.";
      }
      where.orderNumber = n;
    } else {
      const digits = normaliseNumber(callerNumber);
      if (!digits) return 'No caller number — ask them for their order number.';
      // Match on the last 9 digits so 07700…/+4477… both hit.
      where.customerPhone = { contains: digits.slice(-9) };
    }
    const order = await this.db().order.findFirst({
      where,
      orderBy: { createdAt: 'desc' },
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
      return 'No recent order found for this caller. Offer to transfer them to the shop.';
    }
    const mins = order.estimatedReadyAt
      ? Math.max(0, Math.round((new Date(order.estimatedReadyAt).getTime() - Date.now()) / 60000))
      : null;
    return `Order ${order.orderNumber}, status ${order.status}, ${order.fulfillmentType}, total ${money(
      Number(order.total),
      ctx.currency,
    )}${mins != null ? `, about ${mins} minutes away` : ''}.`;
  }

  private async placeOrder(
    input: any,
    ctx: VoiceContext,
    state: VoiceState,
    callerNumber?: string | null,
  ): Promise<{ result: string; turn?: Partial<VoiceTurn>; sayNow?: string }> {
    if (state.orderId) {
      return { result: `Already placed — order is in. Do not place it again.` };
    }
    if (state.cart.items.length === 0) {
      return { result: 'The order is empty — nothing to place.' };
    }
    // The two locks. The system prompt asks for both read-backs; a prompt is a
    // request, and these are the two failures that get an AI phone line
    // switched off permanently — food nobody ordered, and a driver at the
    // wrong door. So they are enforced here, where the model cannot talk its
    // way past them.
    if (state.pendingItem) {
      return {
        result:
          'An item is still being finished — it is not in the basket. Nothing can be placed until it is.',
      };
    }
    if (!this.orderStillConfirmed(state)) {
      return {
        result: state.orderConfirmed
          ? 'The order has CHANGED since it was confirmed. Call read_back_order again and get a fresh yes before placing anything.'
          : 'You have not read the order back yet. Call read_back_order, say it, and get a yes before placing anything.',
      };
    }
    const isDelivery = state.cart.fulfillmentType === 'DELIVERY';
    // What counts as "we have an address" follows the shop, not the UK.
    const located =
      zoneMode(ctx.deliveryZones as any) === 'AREA'
        ? !!state.cart.deliveryAddress?.area
        : !!state.cart.deliveryAddress?.postcode || !postcodeRequiredFor(ctx.country);
    if (isDelivery && !(state.cart.deliveryAddress?.line1 && located)) {
      return { result: 'You need a delivery address first. Ask for it.' };
    }
    // The flag alone goes stale: an address confirmed and then corrected is an
    // unconfirmed address wearing a confirmed flag.
    if (isDelivery && !this.addressStillConfirmed(state)) {
      return {
        result:
          'The address has not been read back and confirmed. Read it back, wait for a yes, then call confirm_delivery_address.',
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
    const deliveryFee = isDelivery ? this.feeForAddress(state.cart.deliveryAddress, ctx) : 0;
    // Said, not defaulted. "Cash or card?" followed by silence placed an
    // order as cash; anything that is not an actual answer is not an answer.
    const method = String(input?.paymentMethod ?? '').toUpperCase();
    if (method !== 'CASH' && method !== 'CARD') {
      return {
        result: `Not placed — they have not said how they'll pay${method ? ` ("${method}" is not cash or card)` : ''}. Ask "cash or card?" and wait for their answer.`,
      };
    }
    const isCard = method === 'CARD';

    try {
      const order: any = await this.orders.create(
        {
          locationId: ctx.locationId,
          ...(ctx.brandId ? { brandId: ctx.brandId } : {}),
          // VOICE, not "PHONE" — the latter is in neither OrderPlatform nor
          // OrderSource, so every completed call used to fail at the Prisma
          // write and the caller was told their order could not be saved
          // AFTER they had confirmed it.
          orderSource: 'VOICE',
          fulfillmentType: isDelivery ? 'DELIVERY' : 'PICKUP',
          customerInfo: {
            // "cash" reached a receipt as the customer's name: the model
            // answered its own payment question into the name field. A name
            // is not a payment method, a yes, a no, or nothing.
            name: this.customerNameFrom(input?.customerName, state),
            phone: callerNumber ?? undefined,
          },
          ...(isDelivery ? { deliveryAddress: state.cart.deliveryAddress } : {}),
          items,
          subtotal,
          ...(deliveryFee > 0 ? { deliveryFee } : {}),
          total: round2(subtotal + deliveryFee),
          specialInstructions: ['TAKEN BY AI PHONE LINE', input?.notes ? String(input.notes) : '']
            .filter(Boolean)
            .join(' · '),
          // PAYMENT_LINK, not CARD. The board's "Waiting for payment" column
          // matches PAYMENT_LINK / QR_CODE / CARD_TERMINAL, so a card order
          // marked plain CARD sat in New as though it were paid for, and the
          // kitchen cooked it before the link had been opened.
          paymentMethod: isCard ? 'PAYMENT_LINK' : 'CASH',
          paymentStatus: 'PENDING',
          // Keyed on the CALL, not the turn count. With turns.length in the
          // key, a retry one turn later produced a different key and a second
          // real order for the same food.
          idempotencyKey: `voice-${
            state.callId ?? `${ctx.locationId}-${normaliseNumber(callerNumber)}`
          }-${Math.round(subtotal * 100)}`,
        } as any,
        ctx.tenantId,
      );
      state.orderId = order.id;
      // Where it landed, in the words the operator uses: an unpaid card order
      // is PENDING and sits in "Waiting for payment", not New, and "the order
      // never arrived" is otherwise impossible to tell apart from "the order
      // arrived somewhere I wasn't looking".
      this.logger.log(
        `Voice order ${order.orderNumber ?? order.id} placed — status ${order.status}, ` +
          `${isCard ? 'PAYMENT_LINK (waiting for payment)' : 'CASH'}, ` +
          `location ${ctx.locationId}${ctx.brandId ? `, brand ${ctx.brandId}` : ''}`,
      );

      // Remember where they live, so the next call is one yes instead of a
      // recited address. After the order exists, deliberately: an abandoned
      // call should not leave address rows behind.
      if (isDelivery) {
        await this.rememberAddress(ctx, callerNumber, state);
      }

      let extra = '';
      if (isCard && callerNumber) {
        extra = await this.textPaymentLink(ctx, order, callerNumber);
      } else if (isCard) {
        extra =
          ' We have no number for this caller, so no payment link could be sent — tell them they can pay at the shop.';
      } else {
        extra = await this.textReceipt(ctx, order, callerNumber);
      }

      const mins = isDelivery ? ctx.deliveryPrepMinutes : ctx.collectionPrepMinutes;
      // The number is spelled out digit by digit because the caller may well
      // ring back and quote it, and "four thousand and twelve" is not
      // something they can match against a text message.
      const digits = spokenDigits(order.orderNumber ?? '');
      const total = money(round2(subtotal + deliveryFee), ctx.currency);
      return {
        // Said verbatim. An order that has just been placed is the one moment
        // in the call where a caller must hear something — on a live call the
        // model took the payment, placed the order and then said nothing at
        // all, and the line sat silent until it was handed to the other
        // engine. The number, the total and the wait are facts, not a prompt.
        sayNow: `That's all booked in${
          digits ? `, order number ${digits}` : ''
        }. That's ${total}, and it'll be about ${mins} minutes. Thanks for calling, goodbye.`,
        result: `Order placed.${digits ? ` Order number ${digits},` : ''} total ${total}, about ${mins} minutes.${extra}`,
        turn: { orderId: order.id, outcome: 'ORDER' },
      };
    } catch (e: any) {
      this.logger.error(`Voice order create failed: ${e?.message ?? e}`);
      return this.handoverTurn(
        ctx,
        'The order could not be saved, and it is NOT confirmed — do not tell them it is.',
      );
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
      return { result: 'There is no existing order being changed here.' };
    }
    if (!state.orderConfirmed) {
      return {
        result:
          'You have not read the whole order back yet. Call read_back_order, say it, and get a yes — the same as before placing one.',
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
    const isDelivery = state.cart.fulfillmentType === 'DELIVERY';
    const deliveryFee = isDelivery ? this.feeForAddress(state.cart.deliveryAddress, ctx) : 0;

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
        'voice-ai',
      );
      const done = state.amendOrderId;
      state.amendOrderId = undefined;
      return {
        result: `Order ${state.amendReference ?? done} updated. Tell them it's been added and the kitchen has the new ticket.`,
        turn: { orderId: done, outcome: 'ORDER' },
      };
    } catch (e: any) {
      // editOrder refuses for good reasons — past Ready, already paid by card.
      // Say what it said rather than inventing an explanation, and get them a
      // person, because from here only a human can help.
      this.logger.warn(`Voice amend failed for ${state.amendOrderId}: ${e?.message}`);
      return this.handoverTurn(
        ctx,
        `That order can't be changed now: ${
          e?.message ?? 'it has gone too far through the kitchen'
        }.`,
      );
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
    state.cart.fulfillmentType = order.fulfillmentType === 'DELIVERY' ? 'DELIVERY' : 'PICKUP';
    state.cart.fulfillmentChosen = true;
    state.cart.items = order.items.map((it) => ({
      lineId: Math.random().toString(36).slice(2, 9),
      itemId: '',
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
      const postcode = String(addr.postcode ?? '');
      const existing = await this.db().customerAddress.findFirst({
        where: { customerId: customer.id, line1, postcode },
        select: { id: true },
      });
      if (existing) return;

      await this.db().customerAddress.create({
        data: {
          customerId: customer.id,
          label: 'Phone order',
          line1,
          city: String(addr.city ?? ctx.address?.city ?? ''),
          postcode,
          country: addr.country ?? ctx.country ?? 'GB',
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
    if (!ctx.smsReceipt || !to) return '';
    try {
      await this.sms.send({
        tenantId: ctx.tenantId,
        to,
        body: `${ctx.locationName}: order ${order.orderNumber} confirmed, ${money(
          Number(order.total ?? 0),
          ctx.currency,
        )}. Thanks for calling.`,
        purpose: 'OTHER',
        locationId: ctx.locationId,
        brandId: ctx.brandId ?? null,
        orderId: order.id,
      });
      return ' A confirmation text has been sent.';
    } catch (e: any) {
      this.logger.warn(`Voice receipt SMS failed for ${order.id}: ${e?.message}`);
      return '';
    }
  }

  /** Card orders get a Stripe link by text — nobody should read a card number
   *  aloud to a machine, and we never want it in a transcript. */
  private async textPaymentLink(ctx: VoiceContext, order: any, to: string): Promise<string> {
    try {
      // The same send the dashboard's "Text payment link" button makes, rather
      // than a second implementation of it. This one texted the raw Stripe
      // checkout URL, which is nine SMS segments of unreadable query string
      // against one for the short `/p/<code>` link — and billed the shop's
      // wallet for all nine, on the message that is how they get paid.
      await this.payments.sendOrderPaymentLinkSms(ctx.tenantId, order.id, to);
      return ' A payment link has been texted to them.';
    } catch (e: any) {
      this.logger.warn(`Voice payment link failed for order ${order.id}: ${e?.message}`);
      // The order exists and the kitchen has it. Falling back to paying at the
      // shop is far better than telling the caller their order failed.
      return ' The payment text failed — tell them they can pay at the shop.';
    }
  }
}
