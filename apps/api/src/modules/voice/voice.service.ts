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
    const verdict = await this.wallet.canAnswerVoiceCall(ctx.tenantId, ctx.locationId);
    if (!verdict.ok) {
      await this.markNotAnswered(call.id, verdict.reason ?? "NO_FUNDS");
      this.logger.warn(
        `Not answering call ${call.id} for location ${ctx.locationId}: ${verdict.reason} (balance ${verdict.balanceMinor}p, price ${verdict.priceMinor}p)`,
      );
      return { answer: false, callId: call.id, reason: verdict.reason };
    }

    const knownName = await this.knownCallerName(ctx.tenantId, args.from);
    await this.db().voiceCall.update({
      where: { id: call.id },
      data: {
        status: "ANSWERED",
        answeredAt: new Date(),
        transcript: emptyState() as any,
      },
    });

    return {
      answer: true,
      callId: call.id,
      greeting: this.ai.greeting(ctx, knownName),
    };
  }

  /** One turn of conversation: what the caller said in, what to say back out. */
  async onCallerSaid(args: {
    callId: string;
    text: string;
  }): Promise<VoiceTurn> {
    const call = await this.db().voiceCall.findUnique({ where: { id: args.callId } });
    if (!call) return { say: "Sorry, something went wrong.", endCall: true };

    const ctx = await this.contexts.resolve(call.toNumber ?? "");
    if (!ctx) return { say: "Sorry, something went wrong.", endCall: true };

    const state: VoiceState = coerceState(call.transcript);
    const { turn, state: next } = await this.ai.respond({
      ctx,
      state,
      userText: args.text,
      callerNumber: call.fromNumber,
    });

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

    await this.wallet.debitForVoiceCall({
      tenantId: updated.tenantId,
      locationId: updated.locationId,
      voiceCallId: updated.id,
      durationSeconds: updated.durationSeconds ?? 0,
      status: updated.status,
    });
  }

  private async markNotAnswered(callId: string, reason: string): Promise<void> {
    await this.db().voiceCall.update({
      where: { id: callId },
      data: { status: "NOT_ANSWERED", notAnsweredReason: reason, endedAt: new Date() },
    });
  }

  /** "Hi Sarah" beats "Hi". Uses the caller-ID work that already exists. */
  private async knownCallerName(
    tenantId: string,
    from?: string | null,
  ): Promise<string | null> {
    const digits = normaliseNumber(from);
    if (!digits) return null;
    try {
      const customer = await this.db().customer.findFirst({
        where: { tenantId, phone: { contains: digits.slice(-9) } },
        select: { firstName: true, name: true },
        orderBy: { updatedAt: "desc" },
      });
      const raw = customer?.firstName ?? customer?.name ?? null;
      return raw ? String(raw).split(" ")[0] ?? null : null;
    } catch {
      return null;
    }
  }
}
