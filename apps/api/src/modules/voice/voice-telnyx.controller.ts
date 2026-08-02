import {
  Body,
  Controller,
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
  constructor(
    private readonly voice: VoiceService,
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
      // eslint-disable-next-line no-console
      console.error(`voice webhook ${type} failed: ${e?.message ?? e}`);
    }
    return { ok: true };
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
    await this.telnyx.startTranscription(ccid);
  }

  private async onTranscription(ccid: string, p: any): Promise<void> {
    const t = p.transcription_data ?? {};
    // Only act on a finished sentence. Acting on interim results makes the AI
    // answer half a thought and talk over the caller.
    if (t.is_final === false) return;
    const text = String(t.transcript ?? "").trim();
    if (!text) return;

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
      // Let the goodbye finish playing before the line drops.
      setTimeout(() => void this.telnyx.hangup(ccid), 4000);
    }
  }

  private async onHangup(ccid: string, _p: any): Promise<void> {
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
