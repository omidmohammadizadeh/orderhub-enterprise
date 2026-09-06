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
  private async fallbackToRelay(
    ccid: string,
    opts: { alreadySpoke?: boolean } = {},
  ): Promise<void> {
    try {
      await this.telnyx.stopMediaStream(ccid);
      const url = this.relayUrlFor(ccid);
      if (url && (await this.telnyx.startConversationRelay(ccid, {
        url,
        // Never a reason to fail: this runs when the caller is already in
        // silence, and a handover that dies looking up a menu is worse than a
        // handover onto a transcriber that has not been told the menu.
        keyterms: await this.keytermsQuietly(ccid),
        greeting: await this.handoverGreeting(ccid, opts.alreadySpoke === true),
      }))) {
        this.logger.log(`call ${ccid.slice(-8)} moved to the standard engine`);
        return;
      }
      this.logger.error(`call ${ccid.slice(-8)} could not be moved to the standard engine`);
    } catch (e: any) {
      this.logger.error(`fallback to the standard engine failed: ${e?.message ?? e}`);
    }
  }

  /**
   * What the caller hears when the call moves to the other engine.
   *
   * Two completely different moments wear the same name. Mid-call, the caller
   * has been talking to something that has now gone, and the honest thing is
   * to admit the restart — they answered questions that were never written
   * down, and pretending otherwise means acting on an order we do not have.
   *
   * But when the session never became ready, THE CALLER HAS HEARD NOTHING AT
   * ALL. Apologising for a fault they did not experience, skipping the shop's
   * name and going straight to "is that collection or delivery?" is how a shop
   * answers its own phone sounding broken — reported, correctly, as "it is not
   * saying the shop name and it says sorry". They are simply being greeted,
   * a second later than they should have been, so greet them.
   */
  private async handoverGreeting(ccid: string, alreadySpoke: boolean): Promise<string> {
    if (!alreadySpoke) {
      try {
        const session = await this.voice.realtimeSession(ccid);
        if (session?.greeting) return session.greeting;
      } catch {
        /* fall through to the apology, which is still better than silence */
      }
    }
    return "Sorry about that, I lost you for a moment — let's take it from the top. Is this collection or delivery?";
  }

  /** The shop's menu terms, or nothing at all. Never throws. */
  private async keytermsQuietly(ccid: string): Promise<string[]> {
    try {
      return (await this.voice.keytermsFor?.(ccid)) ?? [];
    } catch {
      return [];
    }
  }

  /** The relay's own URL builder, without importing the relay gateway. */
  private relayUrlFor(ccid: string): string | null {
    const base = this.config.get<string>("VOICE_RELAY_URL");
    if (!base) return null;
    return `${base.replace(/\/+$/, "")}?call=${encodeURIComponent(ccid)}&t=${this.tokenFor(ccid)}`;
  }

  /**
   * The socket to the model.
   *
   * A seam, and the reason there is one: every fault on this engine so far has
   * been in the PROTOCOL, not the model — a greeting sent before the session
   * was accepted, a keypress nobody handled, one tool call announced twice, a
   * reply asked for while one was still being spoken. All four are testable
   * without OpenAI in the loop, and none of them were caught by asking
   * somebody to ring the shop again.
   */
  protected connectToModel(url: string): WebSocket {
    return new WebSocket(url, { headers: { Authorization: `Bearer ${this.apiKey()}` } });
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
    const brain = this.connectToModel(model_url);

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
                //
                // At the default sensitivity it does not, on a phone: line
                // noise came through as "Mhm.", which cut the greeting off at
                // "for an update on an order, press" and sent the model
                // straight to "collection or delivery?" before the caller had
                // pressed anything. Everything after that was answering a
                // question nobody asked. A higher bar and a minimum length of
                // speech cost a fraction of a second on a real interruption
                // and stop a car door from ordering a pizza.
                turn_detection: {
                  type: "server_vad",
                  threshold: Number(this.config.get<string>("VOICE_REALTIME_VAD_THRESHOLD") ?? 0.65) || 0.65,
                  prefix_padding_ms: 300,
                  silence_duration_ms: 600,
                },
                // A transcript of the caller, PURELY so this engine can be
                // debugged the way the chained one can. Losing `heard "..."`
                // was the strongest argument against ever trying this.
                transcription: {
                  model:
                    this.config.get<string>("VOICE_REALTIME_TRANSCRIBE_MODEL") ||
                    "gpt-4o-mini-transcribe",
                  // "delivery" came back as "डिलिवरी". The model itself heard
                  // it correctly and carried on, so this only corrupts the log
                  // — but the log is the only way to tell the two engines
                  // apart, so it has to be readable.
                  language: this.config.get<string>("VOICE_REALTIME_LANGUAGE") || "en",
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
    (brain as any).__configured = () => configured;

    // Never leave a caller on a line that cannot speak. If the session is not
    // accepted within a few seconds — a rejected format we ran out of guesses
    // for, a model that will not load, an account without realtime access —
    // give the call back to the engine that works.
    const readyBy = setTimeout(() => {
      if (configured) return;
      const stats = this.statsOf(brain);
      // Which of the three this was cannot be guessed at afterwards: a socket
      // that never opened, one that opened and heard nothing back, or a
      // session that was refused in a way we failed to notice. They need
      // different fixes and they look identical in a log that only says the
      // call was handed over.
      this.logger.error(
        `realtime session never became ready on ${ccid.slice(-8)} — handing the call to the standard engine ` +
          `(socket ${brain.readyState}, ${stats.fromModel} events in / ${stats.toModel} out, ` +
          `last "${stats.lastType}")`,
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
      // Nothing has been said to this caller yet, so they get greeted rather
      // than apologised to.
      void this.fallbackToRelay(ccid, { alreadySpoke: false });
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

    // A WebSocket that has died does not say so: it stays readyState OPEN,
    // swallows everything sent into it and returns nothing. On the wire that
    // is indistinguishable from a model taking its time — which is how a
    // caller came to sit through fourteen seconds of nothing while we appended
    // audio to a socket with no one on the other end. A ping every few seconds
    // separates the two, and an unanswered one is a dead line, not a slow one.
    const beat = setInterval(() => {
      if (brain.readyState !== WebSocket.OPEN) return;
      const stats = this.statsOf(brain);
      if (stats.pingAt && !stats.pongAt) {
        this.logger.error(
          `realtime ${ccid.slice(-8)} model socket stopped answering — handing to the standard engine`,
        );
        clearInterval(beat);
        this.calls.delete(ccid);
        try {
          brain.close();
        } catch {
          /* already gone */
        }
        void this.fallbackToRelay(ccid, { alreadySpoke: true });
        return;
      }
      stats.pingAt = Date.now();
      stats.pongAt = 0;
      try {
        brain.ping?.();
      } catch {
        /* the close handler will deal with it */
      }
    }, Number(this.config?.get<string>("VOICE_REALTIME_PING_MS") ?? 5000) || 5000);
    // Nothing about a heartbeat should keep a process alive on its own.
    (beat as any).unref?.();
    brain.on("pong", () => {
      this.statsOf(brain).pongAt = Date.now();
    });
    brain.on("close", () => clearInterval(beat));
    brain.on("error", (e: any) =>
      this.logger.error(`realtime model socket error on ${ccid.slice(-8)}: ${e?.message}`),
    );
    brain.on("close", (code, reason) => {
      this.logger.log(
        `realtime model closed for ${ccid.slice(-8)} (${code} ${reason?.toString() ?? ""})`,
      );
      // The caller is still on the line and the thing that was talking to them
      // has gone. A deploy does this — the old instance shuts down mid-call and
      // both sockets go with it — and so does any dropped connection. Silence
      // is the one outcome that is never acceptable.
      if (!this.calls.has(ccid)) return;
      this.calls.delete(ccid);
      this.logger.error(
        `realtime model dropped mid-call on ${ccid.slice(-8)} — handing to the standard engine`,
      );
      try {
        caller.close();
      } catch {
        /* already gone */
      }
      void this.fallbackToRelay(ccid, { alreadySpoke: true });
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
        this.send(brain, { type: "input_audio_buffer.append", audio: frame.media.payload });
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

    // Stop talking first.
    //
    // Pressing 1 while the options are being read has to END the options —
    // that is the entire point of a keypad. The model is happily generating
    // the rest of the list and every frame of it is already on its way to the
    // caller's ear, so the reply has to be cancelled, not merely followed.
    this.interrupt(brain);

    this.send(brain, {
      type: "conversation.item.create",
      item: { type: "message", role: "user", content: [{ type: "input_text", text: said }] },
    });
    this.send(brain, { type: "response.create" });
  }

  /**
   * Stop whatever the line is saying, now.
   *
   * A caller who presses a key or starts talking has stopped listening, and
   * carrying on to the end of a sentence they have already answered is the
   * thing that makes a phone system feel like a phone system. Audio already
   * generated for the cancelled reply is dropped rather than played, or the
   * caller hears the tail of an answer to a question they interrupted.
   */
  private interrupt(brain: WebSocket): void {
    if (this.responsesOf(brain).size === 0) return;
    this.send(brain, { type: "response.cancel" });
    (brain as any).__responses = new Set<string>();
    (brain as any).__responsePending = false;
    (brain as any).__pendingScript = undefined;
    // Until the next response starts, anything still arriving belongs to the
    // one that was cancelled.
    (brain as any).__dropAudio = true;
  }

  /**
   * What has actually crossed the model socket.
   *
   * "It went silent" is four different faults wearing the same coat: the model
   * never answered, the model answered and the audio never arrived, the socket
   * died without saying so, or we stopped sending it anything. Only the first
   * is the model's fault, and a log of first-occurrence event types cannot
   * tell them apart — which is why the last one cost a live call to guess at.
   */
  private statsOf(brain: WebSocket): {
    fromModel: number;
    toModel: number;
    audioIn: number;
    audioOut: number;
    lastEventAt: number;
    lastType: string;
    pingAt: number;
    pongAt: number;
  } {
    return ((brain as any).__stats ??= {
      fromModel: 0,
      toModel: 0,
      audioIn: 0,
      audioOut: 0,
      lastEventAt: Date.now(),
      lastType: "-",
      pingAt: 0,
      pongAt: 0,
    });
  }

  /** The responses currently being spoken, by id. */
  private responsesOf(brain: WebSocket): Set<string> {
    return ((brain as any).__responses ??= new Set<string>());
  }

  /** Everything we say to the model goes through here, so it can be counted. */
  private send(brain: WebSocket, frame: Record<string, unknown>): void {
    const stats = this.statsOf(brain);
    stats.toModel += 1;
    if (frame.type === "input_audio_buffer.append") stats.audioOut += 1;
    try {
      brain.send(JSON.stringify(frame));
    } catch (e: any) {
      this.logger.error(`realtime could not reach the model: ${e?.message ?? e}`);
    }
  }

  /** A reply that was queued behind another one. */
  private flushPending(brain: WebSocket): void {
    if (!(brain as any).__responsePending) return;
    (brain as any).__responsePending = false;
    const script = (brain as any).__pendingScript;
    (brain as any).__pendingScript = undefined;
    this.speakExactly(brain, script);
  }

  /**
   * Ask for the next reply — and when there are words that must not be
   * paraphrased, insist on them.
   *
   * The same mechanism the greeting uses. A read-back or an order confirmation
   * is a statement of fact about the basket and the price, and a model
   * retelling it in its own words is a model that can get it wrong in the one
   * place nobody can afford it.
   */
  private speakExactly(brain: WebSocket, script?: string): void {
    this.send(
      brain,
      script
        ? {
            type: "response.create",
            response: { instructions: `Say this to the caller, word for word, and nothing else: "${script}"` },
          }
        : { type: "response.create" },
    );
  }

  /** The model produced audio, so the line is alive. */
  private heardFromModel(brain: WebSocket): void {
    const timer = (brain as any).__quiet;
    if (timer) clearTimeout(timer);
    (brain as any).__quiet = undefined;
    (brain as any).__nudged = false;
  }

  /**
   * The caller is waiting. Nothing above this line can promise they get an
   * answer — a refused reply, a tool that returns nothing the model acts on, a
   * socket that is open but idle all end the same way, with somebody holding a
   * phone to their ear hearing nothing and hanging up.
   *
   * So: ask once, and if that also produces nothing, give the call to the
   * engine that has been answering this phone for months.
   */
  private watchForSilence(brain: WebSocket, ccid: string, mode: "reply" | "idle" = "reply"): void {
    // Optional chaining because this runs on the tool path: a throw here
    // would skip the reply, which is the very silence it exists to prevent.
    // Three seconds.
    //
    // In a conversation that is already a long pause — say nothing for three
    // seconds to somebody on a phone and they say "hello? hello?". Five was
    // chosen when the recovery was a silent retry that might not work; now the
    // recovery is a sentence the caller can answer, so it can afford to be
    // early. Two rounds is six seconds before the call moves engine, which is
    // about as long as anyone will hold.
    const quiet =
      mode === "idle"
        ? Number(this.config?.get<string>("VOICE_REALTIME_IDLE_MS") ?? 10_000) || 10_000
        : Number(this.config?.get<string>("VOICE_REALTIME_QUIET_MS") ?? 3000) || 3000;
    const timer = (brain as any).__quiet;
    if (timer) clearTimeout(timer);
    const timer2 = setTimeout(() => {
      (brain as any).__quiet = undefined;
      if (brain.readyState !== WebSocket.OPEN) return;
      const stats = this.statsOf(brain);
      const since = Date.now() - stats.lastEventAt;
      // Everything needed to name the cause on the FIRST log after a bad call:
      // a live socket that answered a ping but sent no events is the model
      // stalling; a socket with no pong is dead; audioOut climbing with
      // audioIn flat is the model hearing nothing.
      const picture =
        `last "${stats.lastType}" ${since}ms ago, ${stats.fromModel} in / ${stats.toModel} out, ` +
        `audio ${stats.audioIn} in / ${stats.audioOut} out, ` +
        `socket ${brain.readyState}, pong ${stats.pongAt ? `${Date.now() - stats.pongAt}ms ago` : "never"}`;
      if (!(brain as any).__nudged) {
        (brain as any).__nudged = true;
        this.logger.warn(`realtime ${ccid.slice(-8)} nothing came back — asking again (${picture})`);
        // Not cleared blindly: if a response really is running, pretending
        // otherwise asks for a second one and earns a refusal.
        if (this.responsesOf(brain).size > 0 && since > quiet) {
          this.logger.warn(
            `realtime ${ccid.slice(-8)} a reply was left half-finished — dropping it`,
          );
          (brain as any).__responses = new Set<string>();
        }
        // WORDS, not another request for a reply.
        //
        // Asking a model that has just produced nothing to produce something
        // is asking the same question that already failed. A caller sitting in
        // silence needs to hear a human-sounding sentence and be given
        // something to answer — from their side, silence on a phone line is
        // indistinguishable from being hung up on.
        this.speakExactly(
          brain,
          mode === "idle"
            ? "Sorry, are you still there?"
            : "Sorry, I lost you there for a second. Where would you like to start — shall I take the order from the top?",
        );
        this.watchForSilence(brain, ccid, mode);
        return;
      }
      this.logger.error(`realtime ${ccid.slice(-8)} still nothing (${picture})`);
      this.logger.error(
        `realtime ${ccid.slice(-8)} silent twice over — handing to the standard engine`,
      );
      this.calls.delete(ccid);
      void this.fallbackToRelay(ccid, { alreadySpoke: true });
    }, quiet);
    // A watchdog is not a reason for a process to stay alive.
    (timer2 as any).unref?.();
    (brain as any).__quiet = timer2;
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
    const stats = this.statsOf(brain);
    stats.fromModel += 1;
    stats.lastEventAt = Date.now();
    stats.lastType = type;

    switch (type) {
      // GA renamed this. Both spellings are accepted so a rename in either
      // direction cannot silence the line.
      case "response.output_audio.delta":
      case "response.audio.delta":
        if (event.delta && !(brain as any).__dropAudio) {
          this.statsOf(brain).audioIn += 1;
          this.heardFromModel(brain);
          sendAudio(event.delta);
        }
        return;

      // session.created arrives the instant the socket opens, carrying the
      // DEFAULTS — 24kHz PCM. Greeting on it sent 24kHz audio down an 8kHz
      // μ-law phone line, which is silence with extra steps. Only
      // session.updated means our settings were accepted.
      case "session.created":
        // Logged, because its absence is the whole diagnosis when a session
        // never becomes ready: this arriving means OpenAI accepted the socket
        // and is answering, and the fault is in what we asked for. Nothing
        // arriving means the fault is further out than us.
        this.logger.log(`realtime ${ccid.slice(-8)} session.created — waiting for our settings`);
        return;

      // A yes/no flag was wrong here: two responses can be in flight at once,
      // and one of them finishing then read as "nothing is running". The next
      // tool asked for a reply mid-reply, was refused, and the line stopped
      // talking. Count them.
      case "response.created":
        (brain as any).__dropAudio = false;
        this.responsesOf(brain).add(String(event.response?.id ?? `r${Date.now()}`));
        return;

      case "response.done": {
        // The line has stopped talking. Whatever happens next — the caller
        // answering, a tool, nothing at all — somebody is now waiting, and
        // until this the watchdog was armed ONLY by a transcript arriving or a
        // tool running. On 6 September neither happened: the line asked
        // "would you like the same as last time?", the caller said no, and
        // there is not one line in the log after that. Nothing was watching,
        // so nothing recovered, and the call died in silence.
        this.watchForSilence(brain, ccid, "idle");
        const running = this.responsesOf(brain);
        const id = String(event.response?.id ?? "");
        if (id && running.has(id)) running.delete(id);
        else running.delete(running.values().next().value ?? "");
        if (running.size === 0) this.flushPending(brain);
        return;
      }

      // What the line actually SAID. Without it, "it went silent" is a report
      // that cannot be told apart from "it spoke and the audio never arrived",
      // and those have completely different causes.
      case "response.output_audio_transcript.done":
        if (event.transcript) {
          this.logger.log(
            `realtime ${ccid.slice(-8)} said ${JSON.stringify(String(event.transcript).trim().slice(0, 200))}`,
          );
        }
        return;
      case "session.updated":
        (brain as any).__onConfigured?.();
        return;

      // The caller's own words, logged in the same shape the chained engine
      // logs them. Without this the two engines cannot be compared, and a bad
      // call on this one could not be diagnosed at all.
      // VAD says they have stopped talking. From here the line OWES them a
      // reply, and it is on the short clock — earlier and more reliable than
      // waiting for a transcript, which on the call above never came.
      case "input_audio_buffer.speech_stopped":
      case "input_audio_buffer.committed":
        this.watchForSilence(brain, ccid, "reply");
        return;

      case "conversation.item.input_audio_transcription.completed":
        // Kept, because a tool sometimes has to be held to what the caller
        // actually said rather than to what the model believes they meant.
        (brain as any).__lastHeard = String(event.transcript ?? "").trim();
        this.logger.log(
          `realtime ${ccid.slice(-8)} heard ${JSON.stringify(String(event.transcript ?? "").trim())}`,
        );
        // The caller has finished a sentence and is now waiting. Everything
        // after this point is on a clock: whatever goes wrong upstream, a
        // person holding a phone gets an answer.
        this.watchForSilence(brain, ccid);
        return;

      // GA can deliver a finished tool call either way round. Handling only
      // one of them would look exactly like a model that never calls tools.
      // GA emits BOTH of these for the SAME tool call — I handled both on the
      // assumption one had replaced the other, so every tool ran twice, two
      // outputs came back under one call_id, and two responses were asked for
      // at once. The second collided with the first and the line went silent
      // mid-order. Once per call_id, whichever event announces it first.
      case "response.output_item.done":
      case "response.function_call_arguments.done": {
        const item = event.item ?? {};
        if (type === "response.output_item.done" && item.type !== "function_call") return;
        const name = String(event.name ?? item.name ?? "");
        const callId = String(event.call_id ?? item.call_id ?? "");
        const handled: Set<string> =
          ((brain as any).__handledTools ??= new Set<string>());
        if (!callId || handled.has(callId)) {
          if (callId) this.logger.log(`realtime ${ccid.slice(-8)} ignored a repeat of ${name}`);
          return;
        }
        handled.add(callId);
        this.logger.log(`realtime ${ccid.slice(-8)} calling ${name}`);
        let args: any = {};
        try {
          args = JSON.parse(event.arguments ?? item.arguments ?? "{}");
        } catch {
          /* the model sent something unparseable; the tool decides */
        }
        const out = await this.voice
          .realtimeTool(ccid, name, { ...args, __heard: (brain as any).__lastHeard ?? null })
          .catch((e: any) => ({ result: `That failed: ${e?.message ?? e}`, turn: undefined }));
        // Everything below this point must survive a tool that answered oddly.
        // A thrown TypeError here would skip the output AND the reply, which
        // the caller experiences as the line simply stopping.
        const said = typeof out?.result === "string" && out.result ? out.result : "Done.";
        this.logger.log(`realtime ${ccid.slice(-8)} tool ${name} → ${said.slice(0, 120)}`);
        brain.send(
          JSON.stringify({
            type: "conversation.item.create",
            item: {
              type: "function_call_output",
              call_id: callId,
              output: said,
            },
          }),
        );
        // Some answers are not the model's to phrase.
        //
        // The read-back is the promise this whole line rests on: what is said
        // aloud has to BE the basket, priced from the basket. Handing the
        // model the script and hoping is not that — on a live call it read
        // back a pepperoni pizza it had never added, the caller said yes, and
        // the order that reached the kitchen was chips and a garlic sauce. The
        // chained engine has always spoken these verbatim; this one was
        // dropping the script on the floor.
        const script = (out as any)?.sayNow;
        if (this.responsesOf(brain).size > 0) {
          (brain as any).__responsePending = true;
          if (script) (brain as any).__pendingScript = script;
        } else {
          this.speakExactly(brain, script);
        }
        // A tool answer that produces no speech is the same silence by another
        // route, so the clock runs on this too.
        this.watchForSilence(brain, ccid);

        // Telephony stays out of VoiceService — that is what lets both engines
        // share it — so the two side effects a tool can have are done here.
        if (out?.turn?.transferTo) {
          setTimeout(() => void this.telnyx.transfer(ccid, out.turn!.transferTo!), 3000);
        } else if (out?.turn?.endCall) {
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
        // "Conversation already has an active response." Nothing acted on
        // this, and because the line only ever speaks when asked to, the one
        // refusal was the end of the call. Ask again the moment the response
        // that was in the way finishes.
        if (/active_response|already has an active/i.test(text)) {
          this.logger.warn(
            `realtime ${ccid.slice(-8)} reply refused as one was already running — queued`,
          );
          if (this.responsesOf(brain).size > 0) (brain as any).__responsePending = true;
          else this.send(brain, { type: "response.create" });
          return;
        }
        this.logger.error(`realtime model error on ${ccid.slice(-8)}: ${text.slice(0, 400)}`);

        // A session we asked for and were refused is not going to be accepted
        // by waiting. Until the readiness timer was the only thing watching
        // this, a caller sat in silence for five more seconds after OpenAI had
        // already said no — on a call where the greeting had not been spoken
        // yet, so all they heard was a shop that did not answer its phone.
        if (!(brain as any).__configured?.() && /session\./.test(String(err?.param ?? ""))) {
          this.logger.error(
            `realtime ${ccid.slice(-8)} session refused — handing to the standard engine now`,
          );
          clearTimeout((brain as any).__readyBy);
          this.calls.delete(ccid);
          try {
            brain.close();
          } catch {
            /* already gone */
          }
          void this.fallbackToRelay(ccid, { alreadySpoke: false });
        }
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
