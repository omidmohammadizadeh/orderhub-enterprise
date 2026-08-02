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

  /** Wait this long after a fragment before deciding the caller has finished. */
  private static readonly SETTLE_MS = 1500;

  /** Below this the engine is guessing, and acting on a guess is how "two
   *  large pepperoni" becomes an order for something else entirely. */
  private static readonly MIN_CONFIDENCE = 0.5;

  /** Menu words for the recogniser — the shop's actual dish names. */
  private async menuHints(ccid: string): Promise<string[]> {
    try {
      const call = await this.db().voiceCall.findUnique({
        where: { providerCallId: ccid },
        select: { toNumber: true },
      });
      if (!call?.toNumber) return [];
      const ctx = await this.contexts.resolve(call.toNumber);
      if (!ctx) return [];
      const words = new Set<string>();
      for (const item of ctx.items) {
        words.add(item.name);
        for (const g of item.modifierGroups) {
          for (const o of g.options) words.add(o.name);
        }
      }
      return [...words].filter((w) => w.length > 2);
    } catch {
      return [];
    }
  }

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
    await this.telnyx.speak(ccid, greeting);
    await this.telnyx.startTranscription(ccid, await this.menuHints(ccid));
  }

  private async onTranscription(ccid: string, p: any): Promise<void> {
    const t = p.transcription_data ?? {};
    // Only act on a finished phrase — a half-formed thought gets answered over.
    if (t.is_final === false) return;
    const text = String(t.transcript ?? "").trim();
    if (!text) return;

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

    // Good enough to use. Join it to whatever is waiting and restart the
    // clock — the caller may not have finished their sentence.
    if (buf) clearTimeout(buf.timer);
    const joined = [buf?.text ?? "", text].filter(Boolean).join(" ").trim();
    this.pending.set(ccid, {
      text: joined,
      lowConfidenceRun: 0,
      timer: setTimeout(
        () => void this.flush(ccid),
        VoiceTelnyxController.SETTLE_MS,
      ),
    });
  }

  /** The caller has stopped talking — answer what they actually said. */
  private async flush(ccid: string): Promise<void> {
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
        await this.telnyx.transfer(ccid, turn.transferTo);
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
