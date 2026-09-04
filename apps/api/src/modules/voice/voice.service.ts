import { Injectable, Logger } from "@nestjs/common";
import { PrismaService } from "../../infrastructure/database/prisma.service";
import { WalletService } from "../wallet/wallet.service";
import { VoiceContextService, normaliseNumber } from "./voice-context.service";
import {
  VoiceAiService,
  coerceState,
  emptyState,
  type VoiceState,
  type VoiceTurn,
} from "./voice-ai.service";
import {
  digitChoice,
  interpretMenuChoice,
  parseFulfillment,
  parsePayment,
  parseSpokenNumber,
  parseYesNo,
  spokenDigits,
  spokenOrderStatus,
  wantsHuman,
  type MenuChoice,
} from "./voice-flow";

// The call, start to finish. Everything the telephony layer needs, and nothing
// about telephony itself — so the same lifecycle works whether the audio comes
// from Telnyx, a test harness, or a typed transcript.
//
// The one rule this file exists to hold: NOT ANSWERING IS SAFE. The AI sits
// behind forward-on-no-answer, so every path that declines a call leaves it
// ringing at the shop exactly as it did before we existed. We are allowed to
// degrade to the old world. We are never allowed to swallow a call.

@Injectable()
export class VoiceService {
  private readonly logger = new Logger(VoiceService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly wallet: WalletService,
    private readonly contexts: VoiceContextService,
    private readonly ai: VoiceAiService,
  ) {}

  private db(): any {
    return this.prisma as any;
  }

  /**
   * A call has arrived. Decide whether to pick up.
   *
   * The VoiceCall row is written BEFORE the decision, so a call we refuse is
   * still visible to the operator. The failure we are designing against is a
   * phone that quietly stops being answered — a row here is the difference
   * between finding out on the dashboard and finding out from a customer.
   */
  async onIncomingCall(args: {
    providerCallId: string;
    from?: string | null;
    to: string;
    provider?: string;
    /** True when the shop's own line rang out first (forward-on-no-answer).
     *  This is what makes a "recovered call" an honest claim. */
    wasOverflow?: boolean;
  }): Promise<{
    answer: boolean;
    callId?: string;
    greeting?: string;
    reason?: string;
  }> {
    const ctx = await this.contexts.resolve(args.to);
    if (!ctx) {
      this.logger.warn(`Inbound call to unmapped number ${args.to} — not answering`);
      return { answer: false, reason: "UNKNOWN_NUMBER" };
    }

    const call = await this.db().voiceCall.upsert({
      where: { providerCallId: args.providerCallId },
      update: {},
      create: {
        tenantId: ctx.tenantId,
        locationId: ctx.locationId,
        brandId: ctx.brandId ?? null,
        providerCallId: args.providerCallId,
        provider: args.provider ?? "TELNYX",
        fromNumber: args.from ?? null,
        toNumber: args.to,
        status: "RINGING",
        wasOverflow: args.wasOverflow === true,
      },
    });

    // Operator kill switch. Off by default — an AI that starts answering a
    // restaurant's phone because a number got assigned is not a feature.
    if (!ctx.enabled) {
      await this.markNotAnswered(call.id, "DISABLED");
      return { answer: false, callId: call.id, reason: "DISABLED" };
    }

    // The money gate. Tries the saved card inline before refusing, so a shop
    // with auto top-up on never notices the balance ran out.
    //
    // Test mode skips it entirely: while we're tuning the conversation, every
    // attempt would otherwise cost £1 and an empty wallet would stop the phone
    // answering halfway through a session.
    const verdict = ctx.testMode
      ? { ok: true as const, balanceMinor: 0, priceMinor: 0, reason: undefined }
      : await this.wallet.canAnswerVoiceCall(ctx.tenantId, ctx.locationId);
    if (!verdict.ok) {
      await this.markNotAnswered(call.id, verdict.reason ?? "NO_FUNDS");
      this.logger.warn(
        `Not answering call ${call.id} for location ${ctx.locationId}: ${verdict.reason} (balance ${verdict.balanceMinor}p, price ${verdict.priceMinor}p)`,
      );
      return { answer: false, callId: call.id, reason: verdict.reason };
    }

    const known = await this.knownCaller(ctx.tenantId, args.from);
    const greeting = this.ai.greeting(ctx, known.name);
    // Seed the greeting as the first assistant turn. It's what the caller
    // actually heard, so the model has to know it already said it — otherwise
    // its first reply introduces the shop a second time. It also saves the
    // telephony layer a column: the greeting to play is simply turn zero.
    const state = emptyState();
    state.turns.push({ role: "assistant", text: greeting });
    state.callId = call.id;
    state.knownName = known.name ?? undefined;
    state.savedAddress = known.address ?? undefined;

    await this.db().voiceCall.update({
      where: { id: call.id },
      data: {
        status: "ANSWERED",
        answeredAt: new Date(),
        transcript: state as any,
      },
    });

    return { answer: true, callId: call.id, greeting };
  }

  /**
   * One turn of conversation: what the caller said in, what to say back out.
   *
   * The stage decides who answers. The menu and the order-status branch are
   * plain code — instant, free, and identical every time. Only the ordering
   * conversation reaches Claude, which is the one part of a call that actually
   * benefits from a model.
   */
  async onCallerSaid(args: {
    callId: string;
    text: string;
    /** Relay transport only: speak this now, more to follow. */
    onPartial?: (chunk: string) => void;
  }): Promise<VoiceTurn> {
    const loaded = await this.load(args.callId);
    // Silence, not an apology. This is reached when the call has already been
    // handed to a human or closed — a late transcript arriving on a bridged
    // leg must not make us talk over the person who just picked up.
    if (!loaded) return { say: "" };
    const { call, ctx, state } = loaded;

    // Before anything else, at any point in the call. "Asking for a human must
    // always work" was only true on the first turn — after that it depended on
    // the model noticing, which is not the same thing.
    if (wantsHuman(args.text)) {
      state.askedForHuman = true;
      state.turns.push({ role: "user", text: args.text });
      return this.handOver(call, ctx, state);
    }

    switch (state.stage) {
      case "MENU":
        return this.applyMenuChoice(
          call,
          ctx,
          state,
          interpretMenuChoice(args.text),
          args.text,
        );
      case "STATUS":
        return this.answerOrderStatus(call, ctx, state, args.text);
      default: {
        // A read-back was just spoken, and the only answer that matters is
        // whether they agreed. Asking a model to work that out costs two to
        // five seconds on the most common turn in the call, for a question a
        // regular expression answers correctly. Anything ambiguous still goes
        // to the model, which is what it is actually good at.
        // Questions whose answer is one word are answered in code. These are
        // the most common turns in the call — collection or delivery, yes or
        // no to a read-back, cash or card — and every one of them used to
        // cost a prompt carrying the whole menu plus a tool round trip.
        const fast = await this.answerSlot(call, ctx, state, args.text);
        if (fast) return fast;
        return this.runBrain(call, ctx, state, args.text, args.onPartial);
      }
    }
  }

  /**
   * The caller pressed a key.
   *
   * Keypresses beat speech everywhere they are both valid: a digit is
   * unambiguous, arrives instantly, and works on a line too poor to transcribe.
   * Zero is a person, everywhere, always — the caller does not have to be told.
   */
  async onDigit(args: { callId: string; digit: string }): Promise<VoiceTurn | null> {
    const loaded = await this.load(args.callId);
    if (!loaded) return null;
    const { call, ctx, state } = loaded;

    const choice = digitChoice(args.digit);
    if (!choice) return null;

    // Outside the menu, only "get me a person" still means anything. A stray
    // keypress mid-order must not restart the call.
    if (state.stage !== "MENU") {
      if (choice.kind !== "HUMAN") return null;
      return this.handOver(call, ctx, state);
    }
    return this.applyMenuChoice(call, ctx, state, choice);
  }

  /** Menu choice → the fixed line the caller hears and the stage they land in. */
  private async applyMenuChoice(
    call: any,
    ctx: any,
    state: VoiceState,
    choice: MenuChoice,
    said?: string,
  ): Promise<VoiceTurn> {
    if (said) state.turns.push({ role: "user", text: said });
    if (choice.kind === "HUMAN") return this.handOver(call, ctx, state);

    if (choice.kind === "STATUS") {
      state.stage = "STATUS";
      const say = this.ai.statusOpener();
      state.turns.push({ role: "assistant", text: say });
      await this.save(call.id, state);
      return { say, outcome: "ORDER_STATUS" };
    }

    state.stage = "ORDER";
    // They talked over the menu and went straight into ordering. Their words
    // are the first real turn — asking "collection or delivery?" as if we
    // hadn't heard them is exactly the deafness this design is trying to fix.
    if (choice.passThrough) {
      // runBrain records the turn itself, so drop the one just added rather
      // than showing the caller's sentence twice on the transcript.
      if (said) state.turns.pop();
      return this.runBrain(call, ctx, state, choice.passThrough);
    }
    const say = this.ai.orderOpener(state);
    state.turns.push({ role: "assistant", text: say });
    // "Collection or delivery?" has two answers. Arm the slot so the reply is
    // understood in code rather than costing a model call.
    state.awaiting = "FULFILLMENT";
    await this.save(call.id, state);
    return { say };
  }

  /**
   * "Where's my order?" — answered from the database, not the model.
   *
   * Deliberately narrow about what it reads out: the stage and the ETA, and
   * nothing else. Never the total, the address or the items. Order numbers are
   * small sequential integers, so anyone can guess one, and a line that reads
   * a stranger's dinner and doorstep back to whoever dials it is a data breach
   * with a phone number attached. Someone chasing their own order never
   * notices the restraint; someone guessing learns nothing worth having.
   */
  private async answerOrderStatus(
    call: any,
    ctx: any,
    state: VoiceState,
    text: string,
  ): Promise<VoiceTurn> {
    const parsed = parseSpokenNumber(text);
    // Order numbers are per-tenant Ints. A caller reciting their phone number
    // by mistake would otherwise overflow the column and 500 the turn.
    const number =
      parsed && parsed.length <= 9 && Number.isSafeInteger(Number(parsed))
        ? parsed
        : null;
    const caller = normaliseNumber(call.fromNumber);

    // Whatever they said belongs on the call record even though no model saw
    // it — the transcript on the dashboard is what settles a dispute.
    state.turns.push({ role: "user", text });

    const order = number
      ? await this.db().order.findFirst({
          where: { locationId: ctx.locationId, orderNumber: Number(number) },
          orderBy: { createdAt: "desc" },
          select: {
            orderNumber: true,
            status: true,
            fulfillmentType: true,
            estimatedReadyAt: true,
            customerPhone: true,
          },
        })
      : // No number heard. Fall back to the number they are ringing from,
        // which is right far more often than it is wrong.
        caller
        ? await this.db().order.findFirst({
            where: {
              locationId: ctx.locationId,
              customerPhone: { contains: caller.slice(-9) },
            },
            orderBy: { createdAt: "desc" },
            select: {
              orderNumber: true,
              status: true,
              fulfillmentType: true,
              estimatedReadyAt: true,
              customerPhone: true,
            },
          })
        : null;

    if (!order) {
      const say = number
        ? `I can't find an order with that number. Let me put you through to the shop.`
        : `Sorry, I didn't catch a number. Let me put you through to the shop.`;
      return this.handOver(call, ctx, state, say);
    }

    const mins = order.estimatedReadyAt
      ? Math.round(
          (new Date(order.estimatedReadyAt).getTime() - Date.now()) / 60000,
        )
      : null;
    const spoken = spokenOrderStatus({
      status: order.status,
      fulfillmentType: order.fulfillmentType,
      minutesAway: mins,
    });
    if (spoken.transfer) return this.handOver(call, ctx, state, spoken.say);

    const say = `Order ${spokenDigits(order.orderNumber ?? "")}. ${spoken.say} Is there anything else I can help with?`;
    state.turns.push({ role: "assistant", text: say });
    // Whatever they say next is ordinary conversation — the brain can take an
    // order, answer a question, or say goodbye from here.
    state.stage = "ORDER";
    await this.save(call.id, state);
    return { say, outcome: "ORDER_STATUS" };
  }

  /**
   * A question we just asked, whose answer is one word.
   *
   * Returns null when the caller said something else — which then goes to the
   * model, where it belongs. The slot is only ever a shortcut for the answer
   * we actually asked for; it never swallows a caller who changed the subject.
   */
  private async answerSlot(
    call: any,
    ctx: any,
    state: VoiceState,
    said: string,
  ): Promise<VoiceTurn | null> {
    const slot = state.awaiting;
    if (!slot) return null;

    let say = "";
    let extra: Partial<VoiceTurn> | undefined;
    let next: VoiceState["awaiting"];

    switch (slot) {
      case "FULFILLMENT": {
        const choice = parseFulfillment(said);
        if (!choice) return null;
        const out = this.ai.fulfillmentAloud(ctx, state, choice);
        say = out.say;
        next = out.next;
        break;
      }
      case "ADDRESS_CONFIRM":
      case "ORDER_CONFIRM": {
        const answer = parseYesNo(said);
        if (!answer) return null;
        if (answer === "NO") {
          say = this.ai.rejectedReadBack(slot);
        } else if (slot === "ADDRESS_CONFIRM") {
          say = await this.ai.confirmAddressAloud(ctx, state);
        } else {
          say = this.ai.confirmOrderAloud(state);
          next = "PAYMENT";
        }
        break;
      }
      case "PAYMENT": {
        const method = parsePayment(said);
        if (!method) return null;
        const out = await this.ai.payAndPlaceAloud(ctx, state, method, call.fromNumber);
        // An empty line means a gate refused the order. That should not
        // happen here, and the model is better placed to explain it than a
        // canned sentence would be.
        if (!out.say) return null;
        say = out.say;
        extra = out.turn;
        next = out.next;
        break;
      }
      case "NAME": {
        const name = this.nameFrom(said);
        if (!name) return null;
        state.knownName = name;
        const out = await this.ai.namedAndPlaceAloud(ctx, state, name, call.fromNumber);
        if (!out.say) return null;
        say = out.say;
        extra = out.turn;
        break;
      }
      default:
        return null;
    }

    state.turns.push({ role: "user", text: said });
    state.awaiting = next;
    // We understood, so the run of misunderstandings is over.
    state.confusion = 0;
    state.turns.push({ role: "assistant", text: say });
    if (extra?.endCall || extra?.transferTo) state.stage = "DONE";

    await this.db().voiceCall.update({
      where: { id: call.id },
      data: {
        transcript: state as any,
        ...(state.orderId ? { orderId: state.orderId, outcome: "ORDER" } : {}),
      },
    });
    return { say, ...extra };
  }

  /**
   * A name out of "it's Omid" / "Omid" / "my name's Omid".
   *
   * Refuses anything that does not look like someone answering with a name —
   * a caller who uses that turn to change their order must reach the model,
   * not have "actually can I add chips" written on the ticket as their name.
   */
  private nameFrom(said: string): string | null {
    const t = String(said ?? "")
      .replace(/[^a-zA-Z\s'-]/g, " ")
      .replace(/\b(it'?s|its|my name'?s?|i'?m|this is|name is|call me|yeah|yes|hi|hello)\b/gi, " ")
      .replace(/\s+/g, " ")
      .trim();
    if (!t) return null;
    const words = t.split(" ").filter(Boolean);
    if (words.length === 0 || words.length > 3) return null;
    const first = words[0];
    if (!first || first.length < 2 || first.length > 20) return null;
    return first.charAt(0).toUpperCase() + first.slice(1).toLowerCase();
  }

  /** The ordering conversation. This is the only path that costs a model call. */
  private async runBrain(
    call: any,
    ctx: any,
    state: VoiceState,
    text: string,
    onPartial?: (chunk: string) => void,
  ): Promise<VoiceTurn> {
    const { turn, state: next } = await this.ai.respond({
      ctx,
      state,
      userText: text,
      callerNumber: call.fromNumber,
      onPartial,
    });
    if (turn.endCall || turn.transferTo) next.stage = "DONE";

    await this.db().voiceCall.update({
      where: { id: call.id },
      data: {
        transcript: next as any,
        ...(next.orderId ? { orderId: next.orderId, outcome: "ORDER" } : {}),
        ...(turn.outcome && !next.orderId ? { outcome: turn.outcome } : {}),
      },
    });
    return turn;
  }

  /** Hand to a human. Always available, from any stage, however they asked. */
  private async handOver(
    call: any,
    ctx: any,
    state: VoiceState,
    say?: string,
  ): Promise<VoiceTurn> {
    const line =
      say ??
      (ctx.transferNumber
        ? "No problem, I'll put you through to the shop now."
        : "Sorry, there's nobody I can put you through to right now. I'll take a message instead — what would you like me to pass on?");
    state.turns.push({ role: "assistant", text: line });
    // Without a transfer number there is nobody to hand to, so the call stays
    // with us and takes a message rather than dropping the caller.
    state.stage = ctx.transferNumber ? "DONE" : "ORDER";
    await this.save(call.id, state);
    return ctx.transferNumber
      ? { say: line, transferTo: ctx.transferNumber, outcome: "TRANSFERRED" }
      : { say: line };
  }

  /** Call row + context + state, or null if any of them has gone. */
  private async load(
    callId: string,
  ): Promise<{ call: any; ctx: any; state: VoiceState } | null> {
    const call = await this.db().voiceCall.findUnique({ where: { id: callId } });
    if (!call) return null;
    // A call we have already handed over or closed takes no further turns. A
    // keypress arriving after a hand-over used to start a brand new order on a
    // call nobody was listening to any more.
    if (["TRANSFERRED", "COMPLETED", "NOT_ANSWERED"].includes(call.status)) {
      return null;
    }
    const state = coerceState(call.transcript);
    // The status column is written by the telephony layer AFTER the turn that
    // decided to hand over returns, so it lags by one turn. The stage is
    // written inside the turn itself and is what actually stops a second
    // hand-over going out for the same caller.
    if (state.stage === "DONE") return null;
    const ctx = await this.contexts.resolve(call.toNumber ?? "");
    if (!ctx) return null;
    return { call, ctx, state };
  }

  private async save(callId: string, state: VoiceState): Promise<void> {
    await this.db().voiceCall.update({
      where: { id: callId },
      data: { transcript: state as any },
    });
  }

  /**
   * The call ended. Close the record and charge for it.
   *
   * Billing happens here and only here, so there is one place where money moves
   * and it runs after the conversation is over — a caller is never waiting on
   * Stripe.
   */
  async onCallEnded(args: {
    callId: string;
    durationSeconds: number;
    status?: string;
  }): Promise<void> {
    const call = await this.db().voiceCall.findUnique({ where: { id: args.callId } });
    if (!call) return;

    // A call we never answered stays as it was — refusing to answer must never
    // be turned into a billable event by an end-of-call webhook.
    if (call.status === "NOT_ANSWERED") return;

    const status =
      args.status ?? (call.status === "TRANSFERRED" ? "TRANSFERRED" : "COMPLETED");
    const updated = await this.db().voiceCall.update({
      where: { id: call.id },
      data: {
        status,
        endedAt: new Date(),
        durationSeconds: Math.max(0, Math.round(args.durationSeconds)),
        // A call that reached no conclusion is an abandon — worth seeing on the
        // dashboard, because a lot of them means the AI is losing people.
        ...(call.outcome ? {} : { outcome: "ABANDONED" }),
      },
    });

    // Test calls are free. Checked from the location rather than carried on
    // the call, so turning test mode ON mid-session can't retroactively bill
    // calls that were already answered under it — and turning it OFF starts
    // charging from the next call, not this one.
    if (await this.isTestLocation(updated.locationId)) {
      this.logger.log(`Voice call ${updated.id} in test mode — not billed`);
      return;
    }

    await this.wallet.debitForVoiceCall({
      tenantId: updated.tenantId,
      locationId: updated.locationId,
      voiceCallId: updated.id,
      durationSeconds: updated.durationSeconds ?? 0,
      status: updated.status,
    });
  }

  /** One cheap read — no menu load — so the end of a call stays light. */
  private async isTestLocation(locationId?: string | null): Promise<boolean> {
    if (!locationId) return false;
    try {
      const loc = await this.db().location.findUnique({
        where: { id: locationId },
        select: { settings: true },
      });
      return (loc?.settings as any)?.voiceTestMode === true;
    } catch {
      // If we can't tell, bill it. Silently giving away calls is the worse
      // failure — an over-charge gets noticed and refunded, an under-charge
      // never does.
      return false;
    }
  }

  private async markNotAnswered(callId: string, reason: string): Promise<void> {
    await this.db().voiceCall.update({
      where: { id: callId },
      data: { status: "NOT_ANSWERED", notAnsweredReason: reason, endedAt: new Date() },
    });
  }

  /**
   * Who is calling, and where do they live?
   *
   * Both come off the same row, so it is one query. The address is what turns
   * the worst part of a phone order — reciting it to a machine — into a single
   * "yes, still there".
   *
   * This used to select `name`, which is not a column on Customer (the model
   * has firstName/lastName). Prisma rejected the query, the catch swallowed
   * it, and every caller was greeted as a stranger — including the regulars
   * the feature was written for.
   */
  private async knownCaller(
    tenantId: string,
    from?: string | null,
  ): Promise<{
    name: string | null;
    address: { line1: string; city: string; postcode: string; country?: string } | null;
  }> {
    const digits = normaliseNumber(from);
    if (!digits) return { name: null, address: null };
    try {
      const customer = await this.db().customer.findFirst({
        // Last nine digits so 07700…, +4477… and 447700… all match.
        where: { tenantId, phone: { contains: digits.slice(-9) } },
        select: {
          firstName: true,
          lastName: true,
          addresses: {
            orderBy: [{ isDefault: "desc" }, { createdAt: "desc" }],
            take: 1,
            select: { line1: true, city: true, postcode: true, country: true },
          },
        },
        orderBy: { updatedAt: "desc" },
      });
      const raw = customer?.firstName ?? null;
      const addr = customer?.addresses?.[0] ?? null;
      return {
        name: raw ? (String(raw).trim().split(" ")[0] ?? null) : null,
        address: addr?.line1
          ? {
              line1: String(addr.line1),
              city: String(addr.city ?? ""),
              postcode: String(addr.postcode ?? ""),
              country: addr.country ? String(addr.country) : undefined,
            }
          : null,
      };
    } catch (e: any) {
      // Never fatal. A caller we cannot identify is greeted as a new one,
      // which is exactly the old behaviour and perfectly serviceable.
      this.logger.warn(`Caller lookup failed: ${e?.message ?? e}`);
      return { name: null, address: null };
    }
  }
}
