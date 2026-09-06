import { Injectable, Logger, OnModuleInit } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { HttpAdapterHost } from "@nestjs/core";
import { createHmac, timingSafeEqual } from "crypto";
import type { IncomingMessage } from "http";
import type { Duplex } from "stream";
import { WebSocketServer, WebSocket } from "ws";
import { PrismaService } from "../../infrastructure/database/prisma.service";
import { VoiceService } from "./voice.service";
import { TelnyxCallControlService } from "./telnyx-call-control.service";

// Speech to speech, as a second engine — not a replacement.
//
// The chained pipeline (Telnyx transcribes → our code and Claude decide →
// Telnyx speaks) is what has been in service, and every bug it has had was
// visible in a `heard "..."` line. That visibility is worth a lot and this
// file does not take it away: the chained engine stays the default, this one
// runs only for a shop whose settings ask for it, and the two can be compared
// on the same menu and the same callers.
//
// What speech-to-speech genuinely does better is HEAR. It never sees
// "Chicken tomatoes up." — it hears the sounds, with the menu already in mind,
// the way a person behind the counter does. That is the one failure class the
// matcher cannot recover from, and the only honest reason to try this.
//
// What it must NOT do is decide things the chained engine decides in code. So
// it calls the SAME tools: place_order still refuses without a read-back, the
// postcode still decides the town, an address outside the delivery area is
// still refused. The experiment is about hearing, not about permission.
//
// Audio is μ-law at 8kHz in both directions — what the phone line already
// carries and what the realtime API accepts — so nothing is resampled.

/** Telnyx → us. */
interface TelnyxMediaFrame {
  event?: string;
  media?: { payload?: string };
  dtmf?: { digit?: string };
  stream_id?: string;
  start?: { call_control_id?: string };
}

@Injectable()
export class VoiceRealtimeGateway implements OnModuleInit {
  private readonly logger = new Logger(VoiceRealtimeGateway.name);
  private wss?: WebSocketServer;
  /** call_control_id → the caller's socket, so a transfer can close it. */
  private readonly calls = new Map<string, WebSocket>();
  private readonly seenEvents = new Set<string>();

  constructor(
    private readonly config: ConfigService,
    private readonly adapterHost: HttpAdapterHost,
    private readonly voice: VoiceService,
    private readonly telnyx: TelnyxCallControlService,
    private readonly prisma: PrismaService,
  ) {}

  private db(): any {
    return this.prisma as any;
  }

  /**
   * The OpenAI key this engine uses.
   *
   * Falls back to the shared one, so a shop can be switched to
   * speech-to-speech with no new configuration at all. But a dedicated key is
   * worth setting: realtime AUDIO is an order of magnitude dearer per minute
   * than the image generation that already uses the shared key, and the whole
   * point of running two engines is to find out what this one costs. OpenAI
   * reports spend per key, so one key per workload is the only way to see it.
   */
  private apiKey(): string | undefined {
    return (
      this.config.get<string>("VOICE_OPENAI_API_KEY") ||
      this.config.get<string>("OPENAI_API_KEY") ||
      undefined
    );
  }

  /** Where Telnyx should stream this call's audio. Null = engine unavailable. */
  streamUrl(callControlId: string): string | null {
    const base = this.config.get<string>("VOICE_REALTIME_URL");
    if (!base || !this.apiKey()) return null;
    return `${base.replace(/\/+$/, "")}?call=${encodeURIComponent(
      callControlId,
    )}&t=${this.tokenFor(callControlId)}`;
  }

  /** Configured at all? Used to explain a refusal rather than fail silently. */
  available(): { ok: boolean; why?: string } {
    if (!this.apiKey()) {
      return {
        ok: false,
        why: "neither VOICE_OPENAI_API_KEY nor OPENAI_API_KEY is set on the API service",
      };
    }
    if (!this.config.get<string>("VOICE_REALTIME_URL")) {
      return { ok: false, why: "VOICE_REALTIME_URL is not set on the API service" };
    }
    return { ok: true };
  }

  private tokenFor(callControlId: string): string {
    const secret =
      this.config.get<string>("VOICE_RELAY_SECRET") ??
      this.config.get<string>("TELNYX_API_KEY") ??
      "";
    return createHmac("sha256", secret).update(callControlId).digest("hex").slice(0, 32);
  }

  private validToken(callControlId: string, token: string): boolean {
    const want = Buffer.from(this.tokenFor(callControlId));
    const got = Buffer.from(String(token ?? ""));
    return want.length === got.length && timingSafeEqual(want, got);
  }

  isConnected(callControlId: string): boolean {
    return this.calls.has(callControlId);
  }

  onModuleInit(): void {
    if (!this.config.get<string>("VOICE_REALTIME_URL")) return;
    const server = this.adapterHost.httpAdapter?.getHttpServer();
    if (!server) {
      this.logger.error("No HTTP server to attach the realtime voice socket to");
      return;
    }

    // Same shape as the relay gateway: noServer plus our own upgrade listener,
    // so socket.io and both voice transports can share one port without any of
    // them claiming a path that isn't theirs.
    this.wss = new WebSocketServer({ noServer: true });
    server.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
      let url: URL;
      try {
        url = new URL(req.url ?? "", "http://localhost");
      } catch {
        return;
      }
      if (!url.pathname.startsWith("/voice/media")) return;

      const call = url.searchParams.get("call") ?? "";
      const token = url.searchParams.get("t") ?? "";
      if (!call || !this.validToken(call, token)) {
        this.logger.warn(`Rejected realtime upgrade for "${call.slice(-8)}"`);
        socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
        socket.destroy();
        return;
      }
      this.wss!.handleUpgrade(req, socket, head, (ws) => void this.attach(ws, call));
    });

    this.logger.log("Speech-to-speech engine listening on /voice/media");
  }

  /** The call hung up — drop the model socket with it. */
  stop(callControlId: string): void {
    const ws = this.calls.get(callControlId);
    if (ws) {
      try {
        ws.close();
      } catch {
        /* already gone */
      }
    }
    this.calls.delete(callControlId);
  }

  /**
   * Hand a call back to the engine that works.
   *
   * Reached when speech-to-speech got as far as a socket and no further. The
   * caller is mid-call and hearing nothing, so this is not the moment to be
   * proud about which engine was selected.
   */
  private async fallbackToRelay(ccid: string): Promise<void> {
    try {
      await this.telnyx.stopMediaStream(ccid);
      const url = this.relayUrlFor(ccid);
      if (url && (await this.telnyx.startConversationRelay(ccid, {
        url,
        greeting: "Sorry about that — I'm with you now. Is this collection or delivery?",
      }))) {
        this.logger.log(`call ${ccid.slice(-8)} moved to the standard engine`);
        return;
      }
      this.logger.error(`call ${ccid.slice(-8)} could not be moved to the standard engine`);
    } catch (e: any) {
      this.logger.error(`fallback to the standard engine failed: ${e?.message ?? e}`);
    }
  }

  /** The relay's own URL builder, without importing the relay gateway. */
  private relayUrlFor(ccid: string): string | null {
    const base = this.config.get<string>("VOICE_RELAY_URL");
    if (!base) return null;
    return `${base.replace(/\/+$/, "")}?call=${encodeURIComponent(ccid)}&t=${this.tokenFor(ccid)}`;
  }

  private async attach(caller: WebSocket, ccid: string): Promise<void> {
    this.calls.set(ccid, caller);
    this.logger.log(`realtime audio open for call ${ccid.slice(-8)}`);

    const session = await this.voice.realtimeSession(ccid).catch((e: any) => {
      this.logger.error(`realtime session setup failed: ${e?.message ?? e}`);
      return null;
    });
    if (!session) {
      caller.close();
      this.calls.delete(ccid);
      return;
    }

    const model =
      this.config.get<string>("VOICE_REALTIME_MODEL") || "gpt-realtime";
    const model_url = `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(model)}`;
    // No OpenAI-Beta header. The beta shape is switched off server-side now:
    //   "The Realtime Beta API is no longer supported. Please use /v1/realtime
    //    for the GA API."
    // which arrived as a 4000 close one second into a live call.
    const brain = new WebSocket(model_url, {
      headers: { Authorization: `Bearer ${this.apiKey()}` },
    });

    let streamId: string | undefined;
    const sendAudio = (b64: string) => {
      if (caller.readyState !== WebSocket.OPEN) return;
      caller.send(JSON.stringify({ event: "media", stream_id: streamId, media: { payload: b64 } }));
    };

    // μ-law is what the phone line carries, and the GA schema takes a format
    // OBJECT where the beta took a string. Which spelling it wants is not
    // written down anywhere I can find, so try them in order of likelihood and
    // say which one worked — the same ladder that settled the Telnyx
    // transcription model after three live calls guessing at it.
    const formats: Array<unknown> = [
      { type: "audio/pcmu" },
      { type: "g711_ulaw" },
      "g711_ulaw",
    ];
    let formatIndex = 0;
    let configured = false;

    const sendSessionUpdate = () => {
      const format = formats[formatIndex];
      brain.send(
        JSON.stringify({
          type: "session.update",
          session: {
            type: "realtime",
            instructions: session.instructions,
            output_modalities: ["audio"],
            audio: {
              input: {
                format,
                // The model decides when the caller has stopped talking. This
                // is the part that is meant to feel better than a timer.
                turn_detection: { type: "server_vad", silence_duration_ms: 500 },
                // A transcript of the caller, PURELY so this engine can be
                // debugged the way the chained one can. Losing `heard "..."`
                // was the strongest argument against ever trying this.
                transcription: {
                  model:
                    this.config.get<string>("VOICE_REALTIME_TRANSCRIBE_MODEL") ||
                    "gpt-4o-mini-transcribe",
                },
              },
              output: {
                format,
                voice: this.config.get<string>("VOICE_REALTIME_VOICE") || "alloy",
              },
            },
            tools: session.tools,
            tool_choice: "auto",
          },
        }),
      );
    };

    /** The API rejected our session. Try the next audio spelling, once each. */
    const retryWithNextFormat = (why: string): boolean => {
      if (configured || formatIndex >= formats.length - 1) return false;
      formatIndex += 1;
      this.logger.warn(
        `realtime rejected audio format ${JSON.stringify(formats[formatIndex - 1])} (${why}) — trying ${JSON.stringify(formats[formatIndex])}`,
      );
      sendSessionUpdate();
      return true;
    };

    const greet = () => {
      brain.send(
        JSON.stringify({
          type: "response.create",
          response: { instructions: `Greet the caller with exactly: "${session.greeting}"` },
        }),
      );
    };

    (brain as any).__onConfigured = () => {
      if (configured) return;
      configured = true;
      clearTimeout((brain as any).__readyBy);
      this.logger.log(
        `realtime session ready on ${ccid.slice(-8)} with audio ${JSON.stringify(formats[formatIndex])}`,
      );
      // Speak first. The caller has just been answered and silence reads as a
      // dead line.
      greet();
    };
    (brain as any).__retryFormat = retryWithNextFormat;

    // Never leave a caller on a line that cannot speak. If the session is not
    // accepted within a few seconds — a rejected format we ran out of guesses
    // for, a model that will not load, an account without realtime access —
    // give the call back to the engine that works.
    const readyBy = setTimeout(() => {
      if (configured) return;
      this.logger.error(
        `realtime session never became ready on ${ccid.slice(-8)} — handing the call to the standard engine`,
      );
      try {
        brain.close();
      } catch {
        /* already gone */
      }
      this.calls.delete(ccid);
      try {
        caller.close();
      } catch {
        /* already gone */
      }
      void this.fallbackToRelay(ccid);
    }, Number(this.config.get<string>("VOICE_REALTIME_READY_MS")) || 5000);
    (readyBy as any).unref?.();
    (brain as any).__readyBy = readyBy;

    brain.on("open", () => {
      this.logger.log(
        `realtime model connected for ${ccid.slice(-8)} (${model}, key=${
          this.config.get<string>("VOICE_OPENAI_API_KEY") ? "voice" : "shared"
        })`,
      );
      sendSessionUpdate();
    });

    brain.on("message", (raw) => void this.onModelEvent(raw.toString(), ccid, brain, sendAudio));
    brain.on("error", (e: any) =>
      this.logger.error(`realtime model socket error on ${ccid.slice(-8)}: ${e?.message}`),
    );
    brain.on("close", (code, reason) => {
      this.logger.log(
        `realtime model closed for ${ccid.slice(-8)} (${code} ${reason?.toString() ?? ""})`,
      );
    });

    caller.on("message", (raw) => {
      let frame: TelnyxMediaFrame;
      try {
        frame = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (frame.event && !this.seenEvents.has(frame.event)) {
        this.seenEvents.add(frame.event);
        this.logger.log(
          `realtime first "${frame.event}" frame: ${JSON.stringify(frame).slice(0, 300)}`,
        );
      }
      if (frame.stream_id) streamId = frame.stream_id;
      if (frame.event === "media" && frame.media?.payload && brain.readyState === WebSocket.OPEN) {
        brain.send(
          JSON.stringify({ type: "input_audio_buffer.append", audio: frame.media.payload }),
        );
        return;
      }

      // Keypresses. The greeting invites them — "to place an order, press 1" —
      // and on this engine they were logged and dropped: the caller pressed 1,
      // then pressed it again, and nothing on earth was listening. The webhook
      // that used to handle them now stands down for realtime calls, which is
      // right, but it left nobody handling them at all.
      if (frame.event === "dtmf" && frame.dtmf?.digit) {
        void this.onDigit(String(frame.dtmf.digit), ccid, brain);
      }
    });

    caller.on("close", () => {
      this.calls.delete(ccid);
      try {
        brain.close();
      } catch {
        /* already gone */
      }
      this.logger.log(`realtime audio closed for call ${ccid.slice(-8)}`);
    });
    caller.on("error", (e: any) =>
      this.logger.warn(`realtime caller socket error on ${ccid.slice(-8)}: ${e?.message}`),
    );
  }

  /**
   * The caller pressed a key.
   *
   * Zero is a person, and that is answered here rather than by asking the
   * model to notice — "getting through to someone must always work" is not a
   * promise to delegate. Everything else is handed over as plain speech,
   * because the model already has the menu in its instructions and the same
   * tools to act on it.
   */
  private async onDigit(digit: string, ccid: string, brain: WebSocket): Promise<void> {
    if (brain.readyState !== WebSocket.OPEN) return;
    this.logger.log(`realtime ${ccid.slice(-8)} pressed ${digit}`);

    if (digit === "0") {
      const out = await this.voice
        .realtimeTool(ccid, "transfer_to_staff", { reason: "The caller pressed 0." })
        .catch(() => null);
      if (out?.turn?.transferTo) {
        setTimeout(() => void this.telnyx.transfer(ccid, out.turn!.transferTo!), 3000);
      }
      return;
    }

    const meaning: Record<string, string> = {
      "1": "wants to place an order",
      "2": "wants an update on an order they have already placed",
      "3": "wants to change an order they have already placed",
      "4": "has a problem with an order",
      "5": "wants to hear the options again",
    };
    const said = meaning[digit]
      ? `The caller pressed ${digit} on their keypad, which means they ${meaning[digit]}. Carry on from there without reading the options out again.`
      : `The caller pressed ${digit} on their keypad.`;

    brain.send(
      JSON.stringify({
        type: "conversation.item.create",
        item: { type: "message", role: "user", content: [{ type: "input_text", text: said }] },
      }),
    );
    brain.send(JSON.stringify({ type: "response.create" }));
  }

  private async onModelEvent(
    raw: string,
    ccid: string,
    brain: WebSocket,
    sendAudio: (b64: string) => void,
  ): Promise<void> {
    let event: any;
    try {
      event = JSON.parse(raw);
    } catch {
      return;
    }
    const type = String(event?.type ?? "");

    switch (type) {
      // GA renamed this. Both spellings are accepted so a rename in either
      // direction cannot silence the line.
      case "response.output_audio.delta":
      case "response.audio.delta":
        if (event.delta) sendAudio(event.delta);
        return;

      // session.created arrives the instant the socket opens, carrying the
      // DEFAULTS — 24kHz PCM. Greeting on it sent 24kHz audio down an 8kHz
      // μ-law phone line, which is silence with extra steps. Only
      // session.updated means our settings were accepted.
      case "session.created":
        return;
      case "session.updated":
        (brain as any).__onConfigured?.();
        return;

      // The caller's own words, logged in the same shape the chained engine
      // logs them. Without this the two engines cannot be compared, and a bad
      // call on this one could not be diagnosed at all.
      case "conversation.item.input_audio_transcription.completed":
        this.logger.log(
          `realtime ${ccid.slice(-8)} heard ${JSON.stringify(String(event.transcript ?? "").trim())}`,
        );
        return;

      // GA can deliver a finished tool call either way round. Handling only
      // one of them would look exactly like a model that never calls tools.
      case "response.output_item.done":
      case "response.function_call_arguments.done": {
        const item = event.item ?? {};
        if (type === "response.output_item.done" && item.type !== "function_call") return;
        const name = String(event.name ?? item.name ?? "");
        const callId = event.call_id ?? item.call_id;
        let args: any = {};
        try {
          args = JSON.parse(event.arguments ?? item.arguments ?? "{}");
        } catch {
          /* the model sent something unparseable; the tool decides */
        }
        const out = await this.voice
          .realtimeTool(ccid, name, args)
          .catch((e: any) => ({ result: `That failed: ${e?.message ?? e}`, turn: undefined }));
        this.logger.log(`realtime ${ccid.slice(-8)} tool ${name} → ${out.result.slice(0, 120)}`);
        brain.send(
          JSON.stringify({
            type: "conversation.item.create",
            item: {
              type: "function_call_output",
              call_id: callId,
              output: out.result,
            },
          }),
        );
        brain.send(JSON.stringify({ type: "response.create" }));

        // Telephony stays out of VoiceService — that is what lets both engines
        // share it — so the two side effects a tool can have are done here.
        if (out.turn?.transferTo) {
          setTimeout(() => void this.telnyx.transfer(ccid, out.turn!.transferTo!), 3000);
        } else if (out.turn?.endCall) {
          setTimeout(() => void this.telnyx.hangup(ccid), 6000);
        }
        return;
      }

      case "error": {
        const err = event.error ?? event;
        const text = JSON.stringify(err);
        // A rejected audio format is recoverable — try the next spelling
        // rather than leaving the caller on a line that cannot speak.
        if (/format/i.test(text) && (brain as any).__retryFormat?.(String(err?.message ?? "").slice(0, 120))) {
          return;
        }
        this.logger.error(`realtime model error on ${ccid.slice(-8)}: ${text.slice(0, 400)}`);
        return;
      }

      default:
        if (!this.seenEvents.has(`model:${type}`)) {
          this.seenEvents.add(`model:${type}`);
          this.logger.log(`realtime first model "${type}" event`);
        }
    }
  }
}
