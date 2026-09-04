import {
  Body,
  Controller,
  Logger,
  HttpCode,
  HttpStatus,
  Post,
  Req,
} from "@nestjs/common";
import { ApiExcludeController } from "@nestjs/swagger";
import type { Request } from "express";
import { Public } from "../../common/decorators/public.decorator";
import { PrismaService } from "../../infrastructure/database/prisma.service";
import { VoiceService } from "./voice.service";
import { VoiceContextService } from "./voice-context.service";
import { TelnyxCallControlService } from "./telnyx-call-control.service";
import { VoiceRelayGateway } from "./voice-relay.gateway";
import { isLikelyHallucination, soundsComplete } from "./voice-flow";

// Where a real phone call meets the brain.
//
// Telnyx does the speech: it plays our text with its own TTS and transcribes
// the caller with its own STT, and every turn arrives here as an ordinary
// webhook. No WebSocket, no audio buffers, no separate media service — which
// is why the AI phone line runs on the same API that serves the dashboard.
//
// The trade is turn-taking latency: the caller finishes, a beat passes, the AI
// replies. Fine for "two large pepperoni, collection". When that beat starts
// costing us callers, the upgrade is streamed audio — and it lands entirely in
// this file and the call-control client, because the brain, the tools, the
// wallet gate and the billing never learn how the audio arrived.

@ApiExcludeController()
@Controller({ path: "voice/telnyx", version: "1" })
export class VoiceTelnyxController {
  private readonly logger = new Logger(VoiceTelnyxController.name);

  constructor(
    private readonly voice: VoiceService,
    private readonly contexts: VoiceContextService,
    private readonly telnyx: TelnyxCallControlService,
    private readonly relay: VoiceRelayGateway,
    private readonly prisma: PrismaService,
  ) {}

  private db(): any {
    return this.prisma as any;
  }

  @Public()
  @Post("webhook")
  @HttpCode(HttpStatus.OK)
  async webhook(@Req() req: Request & { rawBody?: Buffer }, @Body() body: any) {
    const raw = req.rawBody?.toString("utf8") ?? JSON.stringify(body ?? {});
    const ok = this.telnyx.verifySignature(
      raw,
      req.headers["telnyx-signature-ed25519"] as string | undefined,
      req.headers["telnyx-timestamp"] as string | undefined,
    );
    // Always 200. A non-2xx makes Telnyx retry, and retrying a webhook we
    // refused on purpose achieves nothing except noise.
    if (!ok) return { ok: false, reason: "bad_signature" };

    const event = body?.data;
    const type: string = event?.event_type ?? "";
    const p = event?.payload ?? {};
    const ccid: string | undefined = p.call_control_id;
    if (!ccid) return { ok: true };

    // One line per event. Both voice bugs we have had were invisible in the
    // log until someone reproduced them live; a call should be readable end to
    // end from here without turning anything on.
    this.logger.log(
      `call ${ccid.slice(-8)} ${type}${
        type === "call.transcription"
          ? ` "${String(p?.transcription_data?.transcript ?? "").slice(0, 80)}" conf=${p?.transcription_data?.confidence ?? "?"} final=${p?.transcription_data?.is_final !== false}`
          : type === "call.dtmf.received"
            ? ` digit=${p?.digit ?? "?"}`
            : ""
      }`,
    );

    try {
      switch (type) {
        case "call.initiated":
          await this.onInitiated(ccid, p);
          break;
        case "call.answered":
          // Greeting first, then open the caller's mic. Speaking before
          // transcription starts means we never transcribe our own hello.
          await this.onAnswered(ccid);
          break;
        case "call.transcription":
          await this.onTranscription(ccid, p);
          break;
        case "call.dtmf.received":
          await this.onDtmf(ccid, p);
          break;
        case "call.hangup":
          await this.onHangup(ccid, p);
          break;
        default:
          break;
      }
    } catch (e: any) {
      // Never let a handler throw into Telnyx — a 500 here becomes a retry
      // storm on a call that has already moved on.
      this.logger.error(`voice webhook ${type} failed: ${e?.message ?? e}`);
    }
    return { ok: true };
  }

  /**
   * Fragments waiting to be joined into one thought, per call.
   *
   * The first live call came back as " later", " no", " hello" — one to three
   * words at a time, seconds apart. Replying to each scrap is what made the AI
   * feel deaf. We hold them briefly and answer the sentence instead.
   *
   * In memory on purpose: it is worthless the moment the call ends, and the
   * API runs a single instance. If that ever changes this moves to Redis, not
   * to the database — a write per syllable is not a thing worth doing.
   */
  private readonly pending = new Map<
    string,
    { text: string; timer: NodeJS.Timeout; lowConfidenceRun: number }
  >();

  /**
   * How long to wait after a fragment before deciding the caller has finished.
   *
   * The long wait is for speech that trails off mid-thought, which is what the
   * original 1500ms was written for: Google's engine returned word-scraps
   * seconds apart and answering each one made the line feel deaf.
   *
   * Whisper returns whole punctuated utterances instead, so on a finished
   * sentence that wait is a second and a half of silence the caller sits
   * through on EVERY turn, for nothing. Measured on a real call: 1.5s of
   * settle on top of a 5s answer.
   *
   * Both are env-tunable, because the right numbers depend on how the shop's
   * customers actually speak and nobody should need a deploy to find out.
   */
  private readonly settleMs = Number(process.env.VOICE_SETTLE_MS) || 1500;
  private readonly settleCompleteMs =
    Number(process.env.VOICE_SETTLE_COMPLETE_MS) || 400;

  /**
   * One turn at a time, per call.
   *
   * Two transcripts arriving five seconds apart both settled while the first
   * model call was still running, so TWO turns ran concurrently against the
   * same stored state: two model calls, two answers, and — because each had
   * read the state before the other wrote it — two transfer commands for one
   * caller. The second overwrote the first's transcript wholesale.
   *
   * Turns are now chained. Nothing is dropped; the second simply waits, and by
   * the time it runs it can see what the first decided.
   */
  private readonly turnChain = new Map<string, Promise<void>>();

  private queue(ccid: string, work: () => Promise<void>): Promise<void> {
    const next = (this.turnChain.get(ccid) ?? Promise.resolve())
      .catch(() => undefined)
      .then(work);
    this.turnChain.set(ccid, next);
    void next.finally(() => {
      // Only clear if nothing else queued behind us.
      if (this.turnChain.get(ccid) === next) this.turnChain.delete(ccid);
    });
    return next;
  }

  /** Below this the engine is guessing, and acting on a guess is how "two
   *  large pepperoni" becomes an order for something else entirely. */
  private static readonly MIN_CONFIDENCE = 0.5;

  // ── Handlers ────────────────────────────────────────────────────────────

  private async onInitiated(ccid: string, p: any): Promise<void> {
    // Outbound legs (our own transfers) come back through here too.
    if (p.direction && p.direction !== "incoming") return;

    const decision = await this.voice.onIncomingCall({
      providerCallId: ccid,
      from: p.from ?? null,
      to: p.to ?? "",
      provider: "TELNYX",
      // Everything reaching this number got here because the shop's own line
      // rang out — that's what forward-on-no-answer means, and it's what makes
      // "recovered call" an honest word on the dashboard.
      wasOverflow: true,
    });

    if (!decision.answer) {
      // Deliberately do NOT answer or reject. An unanswered call keeps ringing
      // exactly as it did before the AI existed, which is the safe failure we
      // designed for: we are allowed to degrade to the old world, never to
      // swallow a call.
      return;
    }
    await this.telnyx.answer(ccid);
  }

  private async onAnswered(ccid: string): Promise<void> {
    // The greeting is turn zero of the stored conversation — written when we
    // decided to answer, so the model knows what the caller already heard.
    const call = await this.db().voiceCall.findUnique({
      where: { providerCallId: ccid },
      select: { transcript: true },
    });
    const first = (call?.transcript as any)?.turns?.[0];
    const greeting =
      typeof first?.text === "string" && first.text
        ? first.text
        : "Hello, thanks for calling. How can I help?";

    // Conversation Relay when it is configured: one WebSocket for the whole
    // call, Telnyx doing the listening and the speaking, and the first
    // sentence of an answer spoken while the model is still writing the
    // second. The webhook path below is unchanged and stays the default — a
    // shop mid-service is not where a new transport should be proven.
    const relayUrl = this.relay.relayUrl(ccid);
    if (relayUrl) {
      if (await this.telnyx.startConversationRelay(ccid, { url: relayUrl, greeting })) {
        return;
      }
      // Falling back is the whole reason the old path is still here.
      this.logger.error(`Conversation Relay failed to start on ${ccid} — using webhooks`);
    }

    await this.telnyx.speak(ccid, greeting);

    // If we can't listen, say so and hand over. A failed transcription command
    // used to leave the caller talking into a line that wasn't listening —
    // 48 seconds of silence is a worse outcome than any error message.
    const listening = await this.telnyx.startTranscription(ccid);
    if (!listening) {
      this.logger.error(`Transcription failed to start on ${ccid} — handing over`);
      const call = await this.db().voiceCall.findUnique({
        where: { providerCallId: ccid },
        select: { id: true, toNumber: true },
      });
      const ctx = call?.toNumber ? await this.contexts.resolve(call.toNumber) : null;
      await this.telnyx.speak(
        ccid,
        "Sorry, I'm having trouble hearing you. Let me put you through to the shop.",
      );
      if (call) {
        // Marked before the transfer is attempted, so a call we have given up
        // on stops accepting turns even if the transfer itself then fails.
        await this.db().voiceCall.update({
          where: { id: call.id },
          data: { status: "TRANSFERRED", outcome: "TRANSFERRED" },
        });
      }
      await this.handOver(ccid, ctx?.transferNumber);
    }
  }

  /** A keypress is a turn too, and must not race the one already running. */
  private async queueDigit(
    ccid: string,
    callId: string,
    digit: string,
  ): Promise<any> {
    let out: any = null;
    await this.queue(ccid, async () => {
      out = await this.voice.onDigit({ callId, digit });
    });
    return out;
  }

  /**
   * Put them through, or say goodbye properly.
   *
   * A failed transfer used to end the call in silence: we apologised, told
   * them we were putting them through, and then Telnyx rejected the number and
   * nothing else ever happened. Silence after a promise is the worst outcome
   * on this whole line — worse than never answering.
   */
  private async handOver(ccid: string, to?: string | null): Promise<void> {
    if (to && (await this.telnyx.transfer(ccid, to))) return;
    await this.telnyx.speak(
      ccid,
      "Sorry, I can't put you through right now. Please call the shop back in a moment. Goodbye.",
    );
    setTimeout(() => void this.telnyx.hangup(ccid), 6000);
  }

  private async onTranscription(ccid: string, p: any): Promise<void> {
    const t = p.transcription_data ?? {};
    // Only act on a finished phrase — a half-formed thought gets answered over.
    if (t.is_final === false) return;
    const text = String(t.transcript ?? "").trim();
    if (!text) return;

    // Whisper is trained on subtitled video and, on silence or line noise,
    // emits the phrases that pad a subtitle track. A real call produced
    // "Thank you." during a stretch the caller had not spoken in, and it cost
    // a five and a half second model call to answer something nobody said.
    // Answering ghosts also talks over a caller who is simply thinking.
    if (isLikelyHallucination(text)) {
      this.logger.log(`call ${ccid.slice(-8)} ignoring probable silence "${text}"`);
      return;
    }

    const confidence = Number(t.confidence);
    const buf = this.pending.get(ccid);

    // A low-confidence result is the engine guessing. Drop it — but count the
    // run, because a caller being consistently misheard needs to be told,
    // not silently ignored while they wonder if the line has gone dead.
    if (Number.isFinite(confidence) && confidence < VoiceTelnyxController.MIN_CONFIDENCE) {
      const run = (buf?.lowConfidenceRun ?? 0) + 1;
      if (buf) buf.lowConfidenceRun = run;
      if (run >= 2) {
        if (buf) clearTimeout(buf.timer);
        this.pending.delete(ccid);
        await this.telnyx.speak(
          ccid,
          "Sorry, the line isn't very clear. Could you say that again?",
        );
      } else if (!buf) {
        this.pending.set(ccid, {
          text: "",
          lowConfidenceRun: run,
          timer: setTimeout(() => this.pending.delete(ccid), 10_000),
        });
      }
      return;
    }

    // Good enough to use — so the caller is genuinely talking, and we should
    // stop. Only on a confident final result: cutting our own greeting off for
    // a cough or a passing bus is worse than talking half a second too long.
    void this.telnyx.stopSpeaking(ccid);

    // Join it to whatever is waiting and restart the clock — the caller may
    // not have finished their sentence.
    if (buf) clearTimeout(buf.timer);
    const joined = [buf?.text ?? "", text].filter(Boolean).join(" ").trim();
    this.pending.set(ccid, {
      text: joined,
      lowConfidenceRun: 0,
      timer: setTimeout(
        () => void this.flush(ccid),
        soundsComplete(joined) ? this.settleCompleteMs : this.settleMs,
      ),
    });
  }

  /**
   * The caller pressed a key.
   *
   * Handled ahead of speech and without any settle delay, because a keypress
   * is the one input that cannot be misheard. The first thing it does is cut
   * our own voice off: a caller who presses 1 during the greeting should be
   * asked "collection or delivery?" immediately, not after we finish reading
   * out option 2.
   */
  private async onDtmf(ccid: string, p: any): Promise<void> {
    const digit = String(p?.digit ?? p?.digits ?? "").trim();
    if (!digit) return;

    await this.telnyx.stopSpeaking(ccid);

    // A pending fragment is now stale — they answered with the keypad, so
    // whatever half-sentence was waiting must not also be replied to.
    const buf = this.pending.get(ccid);
    if (buf) {
      clearTimeout(buf.timer);
      this.pending.delete(ccid);
    }

    const call = await this.db().voiceCall.findUnique({
      where: { providerCallId: ccid },
      select: { id: true },
    });
    if (!call) return;

    const turn = await this.queueDigit(ccid, call.id, digit);
    if (!turn) return;
    if (turn.say) await this.telnyx.speak(ccid, turn.say);
    if (turn.transferTo) {
      await this.db().voiceCall.update({
        where: { id: call.id },
        data: { status: "TRANSFERRED", outcome: "TRANSFERRED" },
      });
      await this.handOver(ccid, turn.transferTo);
    }
  }

  /** The caller has stopped talking — answer what they actually said. */
  private flush(ccid: string): Promise<void> {
    return this.queue(ccid, () => this.runTurn(ccid));
  }

  private async runTurn(ccid: string): Promise<void> {
    const buf = this.pending.get(ccid);
    this.pending.delete(ccid);
    const text = buf?.text?.trim();
    if (!text) return;

    try {
      const call = await this.db().voiceCall.findUnique({
        where: { providerCallId: ccid },
        select: { id: true },
      });
      if (!call) return;

      const turn = await this.voice.onCallerSaid({ callId: call.id, text });
      if (turn.say) await this.telnyx.speak(ccid, turn.say);

      if (turn.transferTo) {
        await this.db().voiceCall.update({
          where: { id: call.id },
          data: { status: "TRANSFERRED", outcome: "TRANSFERRED" },
        });
        await this.handOver(ccid, turn.transferTo);
        return;
      }
      if (turn.endCall) {
        setTimeout(() => void this.telnyx.hangup(ccid), 4000);
      }
    } catch (e: any) {
      this.logger.error(`voice flush failed: ${e?.message ?? e}`);
    }
  }

  private async onHangup(ccid: string, _p: any): Promise<void> {
    this.telnyx.markEnded(ccid);
    this.turnChain.delete(ccid);
    const buf = this.pending.get(ccid);
    if (buf) {
      clearTimeout(buf.timer);
      this.pending.delete(ccid);
    }

    const call = await this.db().voiceCall.findUnique({
      where: { providerCallId: ccid },
      select: { id: true, answeredAt: true },
    });
    if (!call) return;

    const seconds = call.answeredAt
      ? Math.max(0, Math.round((Date.now() - new Date(call.answeredAt).getTime()) / 1000))
      : 0;
    await this.voice.onCallEnded({
      callId: call.id,
      durationSeconds: seconds,
    });
  }
}
