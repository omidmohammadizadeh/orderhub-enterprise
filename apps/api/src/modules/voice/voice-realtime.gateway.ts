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

  /** Where Telnyx should stream this call's audio. Null = engine unavailable. */
  streamUrl(callControlId: string): string | null {
    const base = this.config.get<string>("VOICE_REALTIME_URL");
    if (!base || !this.config.get<string>("OPENAI_API_KEY")) return null;
    return `${base.replace(/\/+$/, "")}?call=${encodeURIComponent(
      callControlId,
    )}&t=${this.tokenFor(callControlId)}`;
  }

  /** Configured at all? Used to explain a refusal rather than fail silently. */
  available(): { ok: boolean; why?: string } {
    if (!this.config.get<string>("OPENAI_API_KEY")) {
      return { ok: false, why: "OPENAI_API_KEY is not set on the API service" };
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
    const brain = new WebSocket(model_url, {
      headers: {
        Authorization: `Bearer ${this.config.get<string>("OPENAI_API_KEY")}`,
        "OpenAI-Beta": "realtime=v1",
      },
    });

    let streamId: string | undefined;
    const sendAudio = (b64: string) => {
      if (caller.readyState !== WebSocket.OPEN) return;
      caller.send(JSON.stringify({ event: "media", stream_id: streamId, media: { payload: b64 } }));
    };

    brain.on("open", () => {
      this.logger.log(`realtime model connected for ${ccid.slice(-8)} (${model})`);
      brain.send(
        JSON.stringify({
          type: "session.update",
          session: {
            // μ-law both ways: exactly what the phone line carries.
            input_audio_format: "g711_ulaw",
            output_audio_format: "g711_ulaw",
            modalities: ["audio", "text"],
            voice: this.config.get<string>("VOICE_REALTIME_VOICE") || "alloy",
            // The model decides when the caller has stopped. This is the part
            // that is meant to feel better than an endpointing timer.
            turn_detection: { type: "server_vad", silence_duration_ms: 500 },
            // A transcript of the caller, PURELY so this engine can be
            // debugged the way the chained one can. Losing `heard "..."` was
            // the strongest argument against ever trying speech-to-speech.
            input_audio_transcription: { model: "whisper-1" },
            instructions: session.instructions,
            tools: session.tools,
            tool_choice: "auto",
          },
        }),
      );
      // Speak first. The caller has just been answered and silence reads as a
      // dead line.
      brain.send(
        JSON.stringify({
          type: "response.create",
          response: { instructions: `Greet the caller with exactly: "${session.greeting}"` },
        }),
      );
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
      case "response.audio.delta":
        if (event.delta) sendAudio(event.delta);
        return;

      // The caller's own words, logged in the same shape the chained engine
      // logs them. Without this the two engines cannot be compared, and a bad
      // call on this one could not be diagnosed at all.
      case "conversation.item.input_audio_transcription.completed":
        this.logger.log(
          `realtime ${ccid.slice(-8)} heard ${JSON.stringify(String(event.transcript ?? "").trim())}`,
        );
        return;

      case "response.function_call_arguments.done": {
        let args: any = {};
        try {
          args = JSON.parse(event.arguments ?? "{}");
        } catch {
          /* the model sent something unparseable; the tool decides */
        }
        const out = await this.voice
          .realtimeTool(ccid, String(event.name ?? ""), args)
          .catch((e: any) => ({ result: `That failed: ${e?.message ?? e}`, turn: undefined }));
        this.logger.log(
          `realtime ${ccid.slice(-8)} tool ${event.name} → ${out.result.slice(0, 120)}`,
        );
        brain.send(
          JSON.stringify({
            type: "conversation.item.create",
            item: {
              type: "function_call_output",
              call_id: event.call_id,
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

      case "error":
        this.logger.error(
          `realtime model error on ${ccid.slice(-8)}: ${JSON.stringify(event.error ?? event).slice(0, 400)}`,
        );
        return;

      default:
        if (!this.seenEvents.has(`model:${type}`)) {
          this.seenEvents.add(`model:${type}`);
          this.logger.log(`realtime first model "${type}" event`);
        }
    }
  }
}
