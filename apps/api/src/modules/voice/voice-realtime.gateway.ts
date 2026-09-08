import { InboundMeter } from './voice-signal';

/** A frame for the log with the caller's audio replaced by its size. Never the audio. */
const redactAudio = (frame: any): any =>
  frame?.media?.payload
    ? {
        ...frame,
        media: { ...frame.media, payload: `<${String(frame.media.payload).length} b64 chars>` },
      }
    : frame;
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { HttpAdapterHost } from '@nestjs/core';
import { createHmac, timingSafeEqual } from 'crypto';
import type { IncomingMessage } from 'http';
import type { Duplex } from 'stream';
import { WebSocketServer, WebSocket } from 'ws';
import { PrismaService } from '../../infrastructure/database/prisma.service';
import { VoiceService } from './voice.service';
import { TelnyxCallControlService } from './telnyx-call-control.service';

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
  media?: { payload?: string; track?: string };
  dtmf?: { digit?: string };
  stream_id?: string;
  start?: {
    call_control_id?: string;
    media_format?: { encoding?: string; sample_rate?: number; channels?: number };
  };
}

/**
 * The tools that act on a caller having agreed to something. Each one changes
 * what a kitchen makes, or where a driver goes, on the strength of one word.
 */
/** One caller turn, filed against the question it answered. */
interface HeardItem {
  /** Assistant utterances that had finished when this audio was committed. */
  askSeq: number;
  committedAt: number;
  /** The voice detector heard speech; a transcript may still say nothing. */
  spoke: boolean;
  text?: string;
  readable?: boolean;
}

/**
 * One exchange, timed at the points that decide how a call FEELS.
 *
 * The handover's "said" timestamps were generation-done, which is not what
 * the caller experiences. These are: when they stopped talking, when the
 * first byte of the reply reached us, when it reached Telnyx, when the model
 * finished, and when the line will fall silent (an estimate from μ-law bytes
 * queued — playback is not observable from here).
 */
interface TurnTiming {
  speechStoppedAt?: number;
  committedAt?: number;
  firstAudioAt?: number;
  firstForwardedAt?: number;
  generationDoneAt?: number;
  playbackDoneAt?: number;
  responseId?: string;
  /** A tool ran between the caller stopping and the spoken reply. */
  toolStartedAt?: number;
  toolDoneAt?: number;
  toolName?: string;
}

/** Why a reply was asked for. A reminder may speak; it may not act. */
type ResponseOrigin = 'greeting' | 'script' | 'tool' | 'reminder' | 'caller';

/** Tools that change what a kitchen makes or a driver does. Never from a reminder. */
const STATE_CHANGING = new Set([
  'add_item',
  'parse_order',
  'remove_item',
  'change_item',
  'clear_order',
  'set_fulfillment',
  'use_usual',
  'use_saved_address',
  'propose_delivery_address',
  'confirm_delivery_address',
  'order_confirmed',
  'place_order',
  'amend_order',
  'take_message',
]);

/**
 * One request for a reply, and what has become of it.
 *
 * A retry is the same ask with a new reply id, so the budget lives here and
 * not on the id. payload is null for a reply the server started itself (a
 * caller turn), which cannot be retried by us and does not need to be.
 */
interface Ask {
  payload: Record<string, unknown> | null;
  origin: ResponseOrigin;
  attempts: number;
  /** The tool whose script this reply speaks — the question a later yes answers. */
  askedBy?: string;
}

/**
 * Which tool's script a consent tool is answering.
 *
 * On call aqbbdSDA the caller said "OK" to the read-back, the model asked
 * "cash or card?" without calling order_confirmed, the caller said "cash",
 * and order_confirmed then took the CASH turn as its yes — leaving nothing
 * for place_order, which refused. A yes to the read-back is the first thing
 * the caller said after the read-back, not the last thing they said.
 */
const ANSWERS: Record<string, string> = {
  order_confirmed: 'read_back_order',
  amend_order: 'read_back_order',
  confirm_delivery_address: 'propose_delivery_address',
  use_saved_address: 'set_fulfillment',
};
/** A script spoken for one tool that asks the question another tool's answer is judged by. */
const ASKS_AS: Record<string, string> = {
  resolve_address: 'propose_delivery_address',
};

/** Retries per ask, on top of the original. */
const MAX_RETRIES = 2;

/** "Please try again in 1.234s" / "in 800ms" → milliseconds, or null. */
export function rateLimitResetMs(message: string): number | null {
  const m = /try again in\s+(\d+(?:\.\d+)?)\s*(ms|s)\b/i.exec(message ?? '');
  if (!m) return null;
  const n = Number(m[1]);
  return (m[2] ?? '').toLowerCase() === 's' ? Math.round(n * 1000) : Math.round(n);
}

/** Who the line is waiting on. See watchForSilence. */
type CallPhase = 'LISTENING' | 'WAITING_MODEL' | 'WAITING_TOOL' | 'PLAYING' | 'WAITING_CALLER';

/** One assistant audio item as it plays down the phone line. */
interface AudioItem {
  responseId: string;
  contentIndex: number;
  /** When its first byte starts playing — after whatever was queued ahead. */
  startsAt: number;
  totalMs: number;
}

const NEEDS_CONSENT = new Set(['use_usual', 'use_saved_address', 'order_confirmed']);

@Injectable()
export class VoiceRealtimeGateway implements OnModuleInit {
  private readonly logger = new Logger(VoiceRealtimeGateway.name);
  private wss?: WebSocketServer;
  /** call_control_id → the caller's socket, so a transfer can close it. */
  private readonly calls = new Map<string, WebSocket>();
  private readonly seenEvents = new Set<string>();
  /** Calls already handed to the other engine, so a second watcher cannot hand them over again. */
  private handedOver?: Map<string, number>;
  /** The engine stands down until then — an account with no credits refuses every call the same way. */
  private standDown?: { until: number; why: string };

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
      this.config.get<string>('VOICE_OPENAI_API_KEY') ||
      this.config.get<string>('OPENAI_API_KEY') ||
      undefined
    );
  }

  /** Where Telnyx should stream this call's audio. Null = engine unavailable. */
  streamUrl(callControlId: string): string | null {
    const base = this.config.get<string>('VOICE_REALTIME_URL');
    if (!base || !this.apiKey()) return null;
    return `${base.replace(/\/+$/, '')}?call=${encodeURIComponent(
      callControlId,
    )}&t=${this.tokenFor(callControlId)}`;
  }

  /** Configured at all? Used to explain a refusal rather than fail silently. */
  available(): { ok: boolean; why?: string } {
    if (!this.apiKey()) {
      return {
        ok: false,
        why: 'neither VOICE_OPENAI_API_KEY nor OPENAI_API_KEY is set on the API service',
      };
    }
    if (!this.config.get<string>('VOICE_REALTIME_URL')) {
      return { ok: false, why: 'VOICE_REALTIME_URL is not set on the API service' };
    }
    // Two callers in a row each spent two seconds on a model that answered
    // "no credits remaining", then heard an apology for a fault that was
    // ours. An account refusal is not going to change in the next minute;
    // answer on the engine that works and say why, once per call.
    if (this.standDown && Date.now() < this.standDown.until) {
      return { ok: false, why: this.standDown.why };
    }
    return { ok: true };
  }

  private tokenFor(callControlId: string): string {
    const secret =
      this.config.get<string>('VOICE_RELAY_SECRET') ??
      this.config.get<string>('TELNYX_API_KEY') ??
      '';
    return createHmac('sha256', secret).update(callControlId).digest('hex').slice(0, 32);
  }

  private validToken(callControlId: string, token: string): boolean {
    const want = Buffer.from(this.tokenFor(callControlId));
    const got = Buffer.from(String(token ?? ''));
    return want.length === got.length && timingSafeEqual(want, got);
  }

  isConnected(callControlId: string): boolean {
    return this.calls.has(callControlId);
  }

  onModuleInit(): void {
    if (!this.config.get<string>('VOICE_REALTIME_URL')) return;
    const server = this.adapterHost.httpAdapter?.getHttpServer();
    if (!server) {
      this.logger.error('No HTTP server to attach the realtime voice socket to');
      return;
    }

    // Same shape as the relay gateway: noServer plus our own upgrade listener,
    // so socket.io and both voice transports can share one port without any of
    // them claiming a path that isn't theirs.
    this.wss = new WebSocketServer({ noServer: true });
    server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
      let url: URL;
      try {
        url = new URL(req.url ?? '', 'http://localhost');
      } catch {
        return;
      }
      if (!url.pathname.startsWith('/voice/media')) return;

      const call = url.searchParams.get('call') ?? '';
      const token = url.searchParams.get('t') ?? '';
      if (!call || !this.validToken(call, token)) {
        this.logger.warn(`Rejected realtime upgrade for "${call.slice(-8)}"`);
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
        return;
      }
      this.wss!.handleUpgrade(req, socket, head, (ws) => void this.attach(ws, call));
    });

    this.logger.log('Speech-to-speech engine listening on /voice/media');
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
    // Once. The model dropping and the readiness timer both watch the same
    // call, and on 7de77pbA both handed it over: the second start was refused
    // by Telnyx as "already in progress" three times and logged as a failure
    // to move a call that had moved fine.
    const now = Date.now();
    const handed = (this.handedOver ??= new Map<string, number>());
    for (const [id, at] of handed) if (now - at > 10 * 60_000) handed.delete(id);
    if (handed.has(ccid)) {
      this.logger.log(`call ${ccid.slice(-8)} already handed to the standard engine — not again`);
      return;
    }
    handed.set(ccid, now);
    try {
      await this.telnyx.stopMediaStream(ccid);
      const url = this.relayUrlFor(ccid);
      if (
        url &&
        (await this.telnyx.startConversationRelay(ccid, {
          url,
          // Never a reason to fail: this runs when the caller is already in
          // silence, and a handover that dies looking up a menu is worse than a
          // handover onto a transcriber that has not been told the menu.
          keyterms: await this.keytermsQuietly(ccid),
          greeting: await this.handoverGreeting(ccid, opts.alreadySpoke === true),
        }))
      ) {
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
    // An order that is already placed is not taken again. The caller is
    // told it is in, with its number, and nothing more is asked of them.
    const placed = await this.voice.placedOrderFor?.(ccid).catch(() => null);
    if (placed?.reference) {
      return `Sorry, the line's having trouble — but your order is in, number ${placed.reference}. The shop has it. Thanks for calling, goodbye.`;
    }
    // The basket, the address and a confirmation all survive the hand-over;
    // only the engine changed. Ask for what is actually missing — a caller
    // told "let's take it from the top" with everything already taken said
    // "I said it's for delivery, you already got the address, and I said cash".
    const resumed = await this.voice.resumeGreeting?.(ccid).catch(() => null);
    if (resumed) return resumed;
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
    const base = this.config.get<string>('VOICE_RELAY_URL');
    if (!base) return null;
    return `${base.replace(/\/+$/, '')}?call=${encodeURIComponent(ccid)}&t=${this.tokenFor(ccid)}`;
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

    // Telnyx sends the start frame the instant the socket opens — before the
    // session lookup below has returned. With nobody listening it was simply
    // lost, and with it the media_format this call actually arrived in: the
    // first frame ever logged on 7de77pbA was media chunk 18. Kept here and
    // replayed once the real listener is in place. Audio from before then is
    // of no use — there is no model to hear it yet — and is let go.
    let streamId: string | undefined;
    const early: TelnyxMediaFrame[] = [];
    const earlyFrames = (raw: { toString(): string }) => {
      try {
        const f: TelnyxMediaFrame = JSON.parse(raw.toString());
        if (f.stream_id) streamId = f.stream_id;
        if (f.event === 'start') early.push(f);
      } catch {
        /* not ours */
      }
    };
    caller.on('message', earlyFrames);

    const session = await this.voice.realtimeSession(ccid).catch((e: any) => {
      this.logger.error(`realtime session setup failed: ${e?.message ?? e}`);
      return null;
    });
    if (!session) {
      caller.close();
      this.calls.delete(ccid);
      return;
    }

    const model = this.config.get<string>('VOICE_REALTIME_MODEL') || 'gpt-realtime';
    const model_url = `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(model)}`;
    // No OpenAI-Beta header. The beta shape is switched off server-side now:
    //   "The Realtime Beta API is no longer supported. Please use /v1/realtime
    //    for the GA API."
    // which arrived as a 4000 close one second into a live call.
    const brain = this.connectToModel(model_url);

    const sendAudio = (b64: string) => {
      if (caller.readyState !== WebSocket.OPEN) return;
      caller.send(JSON.stringify({ event: 'media', stream_id: streamId, media: { payload: b64 } }));
      // How long this will take to SAY.
      //
      // The model generates a twenty-second greeting in about three, and every
      // frame of it goes straight to Telnyx, which then plays it out in real
      // time. So "the model has finished" and "the caller has finished
      // listening" are twenty seconds apart, and anything that measures
      // silence from the first one is measuring while somebody is still being
      // spoken to. μ-law at 8kHz is one byte per sample.
      const ms = (Buffer.from(b64, 'base64').length / 8000) * 1000;
      const stats = this.statsOf(brain);
      stats.speakingUntil = Math.max(stats.speakingUntil, Date.now()) + ms;
    };

    /**
     * Stop the audio the caller is CURRENTLY HEARING.
     *
     * Cancelling the model stops it generating; it does nothing about the
     * twenty seconds already queued at Telnyx, which is why pressing 1 left
     * the options playing to the end. Telnyx clears its queue on this and
     * stops mid-word, which is exactly what a keypress should do.
     */
    const clearCaller = () => {
      if (caller.readyState !== WebSocket.OPEN) return;
      caller.send(JSON.stringify({ event: 'clear', stream_id: streamId }));
      this.statsOf(brain).speakingUntil = 0;
    };
    (brain as any).__clearCaller = clearCaller;

    // μ-law is what the phone line carries, and the GA schema takes a format
    // OBJECT where the beta took a string. Which spelling it wants is not
    // written down anywhere I can find, so try them in order of likelihood and
    // say which one worked — the same ladder that settled the Telnyx
    // transcription model after three live calls guessing at it.
    const formats: Array<unknown> = [{ type: 'audio/pcmu' }, { type: 'g711_ulaw' }, 'g711_ulaw'];
    let formatIndex = 0;

    // WHEN the caller has finished talking.
    //
    // Silence detection, and it stays silence detection. Semantic detection
    // reads better on paper — it classifies what was actually SAID before
    // ending a turn, which is the honest answer to a breath being taken for a
    // word — and on this phone line it stopped detecting turns at all. Three
    // calls in a row: the caller said hello and not one speech_started,
    // transcript or reply came back. Too eager was a bug; deaf is worse.
    //
    // The breath problem is handled where it actually belongs, on the
    // transcript: a turn with no words in it is not allowed to count as an
    // answer, whatever detected it. That fix does not depend on this setting.
    //
    // Kept behind VOICE_REALTIME_TURN_DETECTION=semantic_vad so it can be
    // tried again deliberately, on a line somebody is watching.
    const turnDetections: Array<Record<string, unknown>> = [
      {
        type: 'server_vad',
        threshold: Number(this.config.get<string>('VOICE_REALTIME_VAD_THRESHOLD') ?? 0.6) || 0.6,
        prefix_padding_ms: 300,
        silence_duration_ms: 600,
      },
      { type: 'semantic_vad', eagerness: 'low' },
    ];
    let turnIndex =
      String(this.config.get<string>('VOICE_REALTIME_TURN_DETECTION') ?? '').toLowerCase() ===
      'semantic_vad'
        ? 1
        : 0;
    let configured = false;

    const sendSessionUpdate = () => {
      const format = formats[formatIndex];
      (brain as any).__turnDetection = turnDetections[turnIndex];
      (brain as any).__mode = (session as any).mode ?? 'REALTIME';
      (brain as any).__ccid = ccid;
      // Re-counted against the rate limit on EVERY reply. The number to look
      // at when a call runs out of budget.
      this.logger.log(
        `realtime ${ccid.slice(-8)} session size: instructions ${String(session.instructions ?? '').length} chars, tools ${JSON.stringify(session.tools ?? []).length} chars (~${Math.round((String(session.instructions ?? '').length + JSON.stringify(session.tools ?? []).length) / 4)} tokens per reply before the conversation)`,
      );
      brain.send(
        JSON.stringify({
          type: 'session.update',
          session: {
            type: 'realtime',
            instructions: session.instructions,
            output_modalities: ['audio'],
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
                turn_detection: turnDetections[turnIndex],
                // A transcript of the caller, PURELY so this engine can be
                // debugged the way the chained one can. Losing `heard "..."`
                // was the strongest argument against ever trying this.
                transcription: {
                  model:
                    this.config.get<string>('VOICE_REALTIME_TRANSCRIBE_MODEL') ||
                    'gpt-4o-mini-transcribe',
                  // "delivery" came back as "डिलिवरी". The model itself heard
                  // it correctly and carried on, so this only corrupts the log
                  // — but the log is the only way to tell the two engines
                  // apart, so it has to be readable.
                  language: this.config.get<string>('VOICE_REALTIME_LANGUAGE') || 'en',
                },
              },
              output: {
                format,
                // marin and cedar are the two OpenAI recommends for quality on
                // gpt-realtime. cedar is the other option, one env var away.
                voice: this.config.get<string>('VOICE_REALTIME_VOICE') || 'marin',
              },
            },
            tools: session.tools,
            tool_choice: 'auto',
          },
        }),
      );
    };

    /** The API would not take semantic turn detection. Fall back to silence. */
    const retryWithoutSemanticVad = (why: string): boolean => {
      if (configured || turnIndex >= turnDetections.length - 1) return false;
      turnIndex += 1;
      this.logger.warn(
        `realtime ${ccid.slice(-8)} turn detection rejected (${why}) — falling back to ${
          (turnDetections[turnIndex] as any).type
        }`,
      );
      sendSessionUpdate();
      return true;
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
          type: 'response.create',
          response: {
            instructions: `Greet the caller with exactly: "${session.greeting}"`,
            tools: [],
            tool_choice: 'none',
            metadata: { origin: 'greeting' },
          },
        }),
      );
    };

    (brain as any).__onConfigured = () => {
      if (configured) return;
      configured = true;
      clearTimeout((brain as any).__readyBy);
      this.logger.log(
        `realtime session ready on ${ccid.slice(-8)} with audio ${JSON.stringify(
          formats[formatIndex],
        )}, turn_detection ${JSON.stringify(turnDetections[turnIndex])}, create_response ${!(
          brain as any
        ).__codeOwnsTurn}, mode ${(brain as any).__mode ?? 'REALTIME'}`,
      );
      // Speak first. The caller has just been answered and silence reads as a
      // dead line.
      greet();
    };
    (brain as any).__retryFormat = retryWithNextFormat;
    (brain as any).__retryTurnDetection = retryWithoutSemanticVad;
    (brain as any).__configured = () => configured;

    // Never leave a caller on a line that cannot speak. If the session is not
    // accepted within a few seconds — a rejected format we ran out of guesses
    // for, a model that will not load, an account without realtime access —
    // give the call back to the engine that works.
    const readyBy = setTimeout(
      () => {
        // Already configured, or already handed over / hung up: nothing to watch.
        if (configured || !this.calls.has(ccid)) return;
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
      },
      Number(this.config.get<string>('VOICE_REALTIME_READY_MS')) || 5000,
    );
    (readyBy as any).unref?.();
    (brain as any).__readyBy = readyBy;

    brain.on('open', () => {
      this.logger.log(
        `realtime model connected for ${ccid.slice(-8)} (${model}, key=${
          this.config.get<string>('VOICE_OPENAI_API_KEY') ? 'voice' : 'shared'
        })`,
      );
      sendSessionUpdate();
    });

    brain.on('message', (raw) => void this.onModelEvent(raw.toString(), ccid, brain, sendAudio));

    // A WebSocket that has died does not say so: it stays readyState OPEN,
    // swallows everything sent into it and returns nothing. On the wire that
    // is indistinguishable from a model taking its time — which is how a
    // caller came to sit through fourteen seconds of nothing while we appended
    // audio to a socket with no one on the other end. A ping every few seconds
    // separates the two, and an unanswered one is a dead line, not a slow one.
    const beat = setInterval(
      () => {
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
      },
      Number(this.config?.get<string>('VOICE_REALTIME_PING_MS') ?? 5000) || 5000,
    );
    // Nothing about a heartbeat should keep a process alive on its own.
    (beat as any).unref?.();
    brain.on('pong', () => {
      this.statsOf(brain).pongAt = Date.now();
    });
    brain.on('close', () => clearInterval(beat));
    brain.on('error', (e: any) =>
      this.logger.error(`realtime model socket error on ${ccid.slice(-8)}: ${e?.message}`),
    );
    brain.on('close', (code, reason) => {
      this.logger.log(
        `realtime model closed for ${ccid.slice(-8)} (${code} ${reason?.toString() ?? ''})`,
      );
      // The caller is still on the line and the thing that was talking to them
      // has gone. A deploy does this — the old instance shuts down mid-call and
      // both sockets go with it — and so does any dropped connection. Silence
      // is the one outcome that is never acceptable.
      if (!this.calls.has(ccid)) return;
      this.calls.delete(ccid);
      clearTimeout((brain as any).__readyBy);
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

    const onCallerFrame = (raw: { toString(): string }) => {
      let frame: TelnyxMediaFrame;
      try {
        frame = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (frame.event && !this.seenEvents.has(frame.event)) {
        this.seenEvents.add(frame.event);
        this.logger.log(
          `realtime first "${frame.event}" frame: ${JSON.stringify(redactAudio(frame)).slice(0, 300)}`,
        );
      }
      if (frame.stream_id) streamId = frame.stream_id;
      // What the line is actually sending, checked against what the model was
      // told to expect. A strong reading on the meter is not proof of speech:
      // A-law decoded as μ-law is loud, and it is noise. The model would sit
      // through it detecting nothing, and the caller would be asked whether
      // they are still there — three times, then goodbye.
      if (frame.event === 'start') {
        const mf = frame.start?.media_format;
        const enc = String(mf?.encoding ?? '').trim();
        const rate = Number(mf?.sample_rate ?? 8000) || 8000;
        const mulaw = !enc || /pcmu|mulaw|ulaw|g711u/i.test(enc);
        this.logger.log(
          `realtime ${ccid.slice(-8)} inbound audio: ${enc || 'encoding unstated'}, ${rate}Hz, ${mf?.channels ?? 1}ch (model expects μ-law 8kHz)`,
        );
        if (!mulaw || rate !== 8000) {
          this.logger.error(
            `realtime ${ccid.slice(-8)} inbound audio is ${enc || '?'} at ${rate}Hz, not μ-law 8kHz — the model would hear noise. Handing the call to the other engine.`,
          );
          (brain as any).__badAudio = true;
          void this.fallbackToRelay(ccid, { alreadySpoke: this.statsOf(brain).audioIn > 0 });
        }
        return;
      }
      if (frame.event === 'media' && frame.media?.payload && brain.readyState === WebSocket.OPEN) {
        // Only the caller's side. With both tracks streamed our own audio
        // would come back down this socket and into the model's ears.
        if (frame.media.track && frame.media.track !== 'inbound') return;
        if ((brain as any).__badAudio) return;
        this.send(brain, { type: 'input_audio_buffer.append', audio: frame.media.payload });
        // What the line sounds like, one number a second, and only logged
        // when it is the thing worth knowing: loud, and nothing detected it.
        // No audio is kept.
        const meter: InboundMeter = ((brain as any).__meter ??= new InboundMeter());
        const w = meter.frame(
          frame.media.payload,
          Date.now(),
          this.phaseOf(brain).phase === 'PLAYING',
        );
        if (w?.loudUndetected && meter.shouldWarn()) {
          this.logger.warn(
            `realtime ${ccid.slice(-8)} inbound loud but undetected: peak ${w.peakDb.toFixed(0)} dBFS over ${w.frames} frames, phase ${this.phaseOf(brain).phase}`,
          );
        }
        return;
      }

      // Keypresses. The greeting invites them — "to place an order, press 1" —
      // and on this engine they were logged and dropped: the caller pressed 1,
      // then pressed it again, and nothing on earth was listening. The webhook
      // that used to handle them now stands down for realtime calls, which is
      // right, but it left nobody handling them at all.
      if (frame.event === 'dtmf' && frame.dtmf?.digit) {
        void this.onDigit(String(frame.dtmf.digit), ccid, brain);
      }
    };
    caller.off('message', earlyFrames);
    caller.on('message', onCallerFrame);
    for (const f of early) onCallerFrame(JSON.stringify(f));

    caller.on('close', () => {
      this.calls.delete(ccid);
      this.cancelRetry(brain, 'hangup');
      try {
        brain.close();
      } catch {
        /* already gone */
      }
      this.logger.log(`realtime audio closed for call ${ccid.slice(-8)}`);
      this.summariseTiming(brain, ccid);
      {
        const m = (brain as any).__meter as InboundMeter | undefined;
        if (m)
          this.logger.log(
            `realtime ${ccid.slice(-8)} inbound line: ${m.totals.windows}s metered, floor ${m.floorDb().toFixed(0)} dBFS, ${m.totals.loudWindows}s loud, ${m.totals.loudUndetected}s loud-but-undetected (not proof of missed speech)`,
          );
      }
    });
    caller.on('error', (e: any) =>
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

    if (digit === '0') {
      const out = await this.voice
        .realtimeTool(ccid, 'transfer_to_staff', { reason: 'The caller pressed 0.' })
        .catch(() => null);
      if (out?.turn?.transferTo) {
        setTimeout(() => void this.telnyx.transfer(ccid, out.turn!.transferTo!), 3000);
      }
      return;
    }

    // On the conversation engine there is no menu and no walkthrough: a
    // digit is whatever the model asked, answered — or a caller who thinks
    // this is a phone system, which the model can gently correct.
    if ((brain as any).__mode === 'CONVERSATION') {
      this.interrupt(brain);
      this.send(brain, {
        type: 'conversation.item.create',
        item: {
          type: 'message',
          role: 'user',
          content: [
            {
              type: 'input_text',
              text: `(The caller pressed ${digit} on their keypad. If that answers what you just asked, take it as the answer; otherwise tell them they can just talk to you, and ask what they'd like.)`,
            },
          ],
        },
      });
      this.send(brain, { type: 'response.create' });
      return;
    }

    // A numbered question beats the menu, always.
    //
    // "For your pizza size, press 1 for 10 inch, 2 for 12 inch" — and 2 was
    // answered with "you want an update on an existing order". Every digit was
    // being read as a main-menu choice for the whole call, however far past
    // the menu it had got.
    const answered = await this.voice.realtimeDigit?.(ccid, digit).catch(() => null);
    if (answered?.say) {
      this.interrupt(brain);
      this.send(brain, {
        type: 'conversation.item.create',
        item: {
          type: 'message',
          role: 'user',
          content: [
            {
              type: 'input_text',
              // A confirmation keypress is the opposite instruction to a
              // walkthrough one: there the answer is already applied and the
              // model must keep out of it, here the answer has only been
              // RECORDED and the model still has to act on it.
              text: answered.confirmed
                ? `They pressed ${digit}, which is a clear ${answered.confirmed.answered} to the question you asked. That is now recorded against this call. ${
                    answered.confirmed.answered === 'YES'
                      ? 'Call the tool you were about to call — it will see their yes.'
                      : 'Treat it as a plain no and carry on without it.'
                  } Do not ask that question again.`
                : `They pressed ${digit}. That answered your question and it has ALREADY been applied to the order — you will say "${answered.say}" next. Do not call add_item, and do not ask that question again.`,
            },
          ],
        },
      });
      this.speakExactly(brain, answered.say);
      this.setTurnOwner(brain, answered.owned === true);
      return;
    }

    // Past the opening menu a digit is an answer to whatever was last asked,
    // not a menu choice. Tell the model what was pressed and let it read that
    // in context rather than announcing an intent the caller never had.
    if (await this.voice.pastTheMenu?.(ccid).catch(() => false)) {
      this.interrupt(brain);
      this.send(brain, {
        type: 'conversation.item.create',
        item: {
          type: 'message',
          role: 'user',
          content: [
            {
              type: 'input_text',
              text: `The caller pressed ${digit} on their keypad. That is their answer to whatever you last asked them — it is NOT a main-menu choice, and this call is past the menu. If you cannot see what it answers, ask them plainly what they meant.`,
            },
          ],
        },
      });
      this.send(brain, { type: 'response.create' });
      return;
    }

    const meaning: Record<string, string> = {
      '1': 'wants to place an order',
      '2': 'wants an update on an order they have already placed',
      '3': 'wants to change an order they have already placed',
      '4': 'has a problem with an order',
      '5': 'wants to hear the options again',
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
      type: 'conversation.item.create',
      item: { type: 'message', role: 'user', content: [{ type: 'input_text', text: said }] },
    });
    this.send(brain, { type: 'response.create' });
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
  /** Whatever retry is waiting, is not any more. */
  private cancelRetry(brain: WebSocket, why: string): void {
    const timer = (brain as any).__retryTimer;
    if (!timer) return;
    clearTimeout(timer);
    (brain as any).__retryTimer = undefined;
    this.logger.log(
      `realtime ${String((brain as any).__ccid ?? '').slice(-8)} pending retry dropped — ${why}`,
    );
  }

  /**
   * A reply failed. Retry the ASK it belonged to — a bounded number of times,
   * after the wait the API named — or stop and hand the caller to the engine
   * that has its own budget.
   */
  private retryAsk(
    brain: WebSocket,
    ccid: string,
    failedId: string,
    code: string,
    message: string,
  ): void {
    if ((brain as any).__closing) {
      this.logger.log(
        `realtime ${ccid.slice(-8)} closing — the goodbye was refused (${code || 'unknown'}); hanging up without it`,
      );
      const prior = (brain as any).__hangup;
      if (prior) clearTimeout(prior);
      void this.telnyx.hangup(ccid);
      return;
    }
    const t = this.turnsOf(brain);
    const ask = t.asks.get(failedId);
    if (!ask) {
      this.watchForSilence(brain, ccid, 'reply');
      return;
    }
    if (!ask.payload) {
      // The server's own reply to a caller turn. If it was throttled, what
      // the caller needs is THAT reply, after the wait — not a scripted
      // apology that the model, still holding their "yes", turned into
      // "the address is confirmed" with nothing confirmed. Anything else
      // that kills a caller reply is left to the watchdog.
      if (code !== 'rate_limit_exceeded') {
        this.watchForSilence(brain, ccid, 'reply');
        return;
      }
      ask.payload = { type: 'response.create', response: { metadata: { origin: 'caller' } } };
    }
    ask.attempts += 1;
    if (ask.attempts > MAX_RETRIES) {
      this.logger.error(
        `realtime ${ccid.slice(-8)} giving up on a ${ask.origin} reply after ${MAX_RETRIES} retries (${code || 'unknown'})`,
      );
      if (!(brain as any).__gaveUp) {
        (brain as any).__gaveUp = true;
        // The other engine has a budget of its own. If an order is already
        // in, the handover says so rather than taking it again.
        this.calls.delete(ccid);
        void this.fallbackToRelay(ccid, { alreadySpoke: true });
      }
      return;
    }
    const reset = code === 'rate_limit_exceeded' ? rateLimitResetMs(message) : null;
    const backoff = 400 * 2 ** (ask.attempts - 1);
    const delay = Math.max(reset ?? 0, backoff) + Math.floor(Math.random() * 250);
    (brain as any).__createBlockedUntil = Date.now() + delay;
    this.logger.warn(
      `realtime ${ccid.slice(-8)} retry ${ask.attempts}/${MAX_RETRIES} of a ${ask.origin} reply in ${delay}ms` +
        (reset !== null ? ` (API asked for ${reset}ms)` : ''),
    );
    this.cancelRetry(brain, 'superseded by a newer retry');
    const timer = setTimeout(() => {
      (brain as any).__retryTimer = undefined;
      if (brain.readyState !== WebSocket.OPEN) return;
      this.send(brain, ask.payload!, { retryOf: ask });
      this.watchForSilence(brain, ccid, 'reply');
    }, delay);
    (timer as any).unref?.();
    (brain as any).__retryTimer = timer;
  }

  private interrupt(brain: WebSocket, opts: { serverCancels?: boolean } = {}): void {
    // The queued audio goes whether or not the model is still generating —
    // by the time somebody presses a key the model has usually finished and
    // the caller is only part-way through hearing it.
    (brain as any).__clearCaller?.();

    // Tell the model where it was cut off.
    //
    // Without this the model's own transcript says it delivered the whole
    // sentence, and it carries on as though the caller heard all of it. The
    // truncation point is the PLAYBACK position — what reached the caller's
    // ear — which is not where generation had got to: generation finishes
    // seconds ahead of the phone line, and can be finished entirely while the
    // caller is still listening.
    const playing = this.playbackOf(brain);
    const t = this.turnsOf(brain);
    if (playing && playing.playedMs < playing.totalMs) {
      this.send(brain, {
        type: 'conversation.item.truncate',
        item_id: playing.itemId,
        content_index: playing.contentIndex,
        audio_end_ms: Math.floor(playing.playedMs),
      });
      const a = t.audio.get(playing.itemId);
      if (a) a.totalMs = playing.playedMs;
    }
    t.currentAudio = undefined;

    if (this.responsesOf(brain).size === 0) return;
    // Anything still arriving for these belongs to what was cancelled, and
    // must not leak into the reply that follows. Tracked per response — a
    // single "drop everything until the next response starts" flag dropped
    // the first frames of the NEXT reply too when the two overlapped.
    for (const id of this.responsesOf(brain)) t.cancelled.add(id);
    // On speech_started the server has already cancelled its own reply;
    // sending another cancel just earns "no active response found".
    if (!opts.serverCancels) this.send(brain, { type: 'response.cancel' });
    (brain as any).__responses = new Set<string>();
    (brain as any).__responsePending = false;
    (brain as any).__toolAwaitingReply = false;
    (brain as any).__pendingScript = undefined;
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
    /** When the audio already handed to Telnyx will finish playing. */
    speakingUntil: number;
  } {
    return ((brain as any).__stats ??= {
      fromModel: 0,
      toModel: 0,
      audioIn: 0,
      audioOut: 0,
      lastEventAt: Date.now(),
      lastType: '-',
      pingAt: 0,
      pongAt: 0,
      speakingUntil: 0,
    });
  }

  /**
   * Give a transcript that is already being written a moment to arrive.
   *
   * Only before the tools where a yes matters, and only for as long as a
   * caller would not notice. Everything else runs immediately.
   */
  private async waitForTranscript(brain: WebSocket, ms = 900): Promise<void> {
    const until = Date.now() + ms;
    const t = this.turnsOf(brain);
    // A committed caller turn whose words have not arrived yet is a transcript
    // on its way. That is the precise thing to wait for; a clock is not.
    // …or a delta has arrived and the completion has not: same thing, seen
    // from the other end, and the only signal when an event lacks an item id.
    const stillComing = () =>
      (brain as any).__transcribing === true ||
      t.order.some((id) => t.heard.get(id)?.text === undefined);
    while (Date.now() < until && stillComing()) {
      await new Promise((r) => setTimeout(r, 50));
    }
  }

  /**
   * Who said what, and in answer to which question.
   *
   * Everything here used to be three globals: the last transcript, the time
   * it arrived, and the time we last spoke. That answers "did they say
   * something after we did?", which is not the question. The question is
   * "did they say THIS in answer to THAT, and has it been used already?" —
   * and transcripts arrive out of order, so arrival time cannot answer it.
   *
   * askSeq counts assistant utterances. A caller item is stamped with the
   * askSeq in force when its audio was COMMITTED (which is in order), not when
   * its transcript arrived (which is not). A response is stamped with the
   * askSeq in force when it was created, so a tool inside it can be judged
   * against the words the caller said before it started — even if the model
   * spoke first in the same response.
   */
  private turnsOf(brain: WebSocket): {
    askSeq: number;
    responseAskSeq: Map<string, number>;
    heard: Map<string, HeardItem>;
    order: string[];
    consumed: Set<string>;
    audio: Map<string, AudioItem>;
    currentAudio?: string;
    cancelled: Set<string>;
    toolResponses: Set<string>;
    /** Responses that produced at least one audio frame. */
    voiced: Set<string>;
    originOf: Map<string, ResponseOrigin>;
    /** Every response.create we sent, in order, until the server names its id. */
    pendingCreates: Ask[];
    /** The ask behind each reply id — a retry's new id maps to the same ask. */
    asks: Map<string, Ask>;
    /** For each scripted question (by the tool that produced it), the askSeq its answers carry. */
    askedFor: Map<string, number>;
  } {
    return ((brain as any).__turns ??= {
      askSeq: 0,
      responseAskSeq: new Map(),
      heard: new Map(),
      order: [],
      consumed: new Set(),
      audio: new Map(),
      currentAudio: undefined,
      cancelled: new Set(),
      toolResponses: new Set(),
      voiced: new Set(),
      originOf: new Map(),
      pendingCreates: [],
      asks: new Map(),
      askedFor: new Map(),
    });
  }

  /** The most recently committed caller turn that has words. */
  private latestHeard(brain: WebSocket): (HeardItem & { itemId: string }) | undefined {
    const t = this.turnsOf(brain);
    for (let i = t.order.length - 1; i >= 0; i--) {
      const id = t.order[i]!;
      const h = t.heard.get(id);
      if (h && h.text !== undefined) return { ...h, itemId: id };
    }
    return undefined;
  }

  /** What the caller is currently hearing, and how far through it they are. */
  private playbackOf(
    brain: WebSocket,
  ): { itemId: string; contentIndex: number; playedMs: number; totalMs: number } | undefined {
    const t = this.turnsOf(brain);
    const id = t.currentAudio;
    const a = id ? t.audio.get(id) : undefined;
    if (!id || !a) return undefined;
    const playedMs = Math.max(0, Math.min(a.totalMs, Date.now() - a.startsAt));
    return { itemId: id, contentIndex: a.contentIndex, playedMs, totalMs: a.totalMs };
  }

  /**
   * Who answers the caller's next turn: the model, or code.
   *
   * While a code-owned question is open — a numbered walkthrough, or "press
   * 1 for yes, 2 for no" — the server must NOT create a reply on its own when
   * the caller stops talking. Two things were answering the same turn: the
   * deterministic handler wrote the choice down and spoke the next question,
   * and the model, hearing the same audio, called add_item for the same
   * pizza. Both were right; together they were a loop.
   *
   * create_response is switched off for exactly that window and back on the
   * moment the question closes. Code that takes the turn creates the reply
   * itself; code that declines it hands the turn to the model explicitly.
   */
  private setTurnOwner(brain: WebSocket, code: boolean): void {
    if (((brain as any).__codeOwnsTurn ?? false) === code) return;
    (brain as any).__codeOwnsTurn = code;
    const td = (brain as any).__turnDetection;
    if (!td) return;
    this.send(brain, {
      type: 'session.update',
      session: {
        type: 'realtime',
        audio: { input: { turn_detection: { ...td, create_response: !code } } },
      },
    });
  }

  private timingOf(brain: WebSocket): { open?: TurnTiming; done: TurnTiming[] } {
    return ((brain as any).__timing ??= { open: undefined, done: [] });
  }

  /** Log what the caller waited for, once per reply, and roll it up at hangup. */
  private closeTurnTiming(brain: WebSocket, ccid: string): void {
    const t = this.timingOf(brain);
    const o = t.open;
    if (!o || !o.speechStoppedAt) return;
    t.done.push(o);
    t.open = undefined;
    const d = (a?: number, b?: number) => (a && b ? b - a : undefined);
    const fmt = (n?: number) => (n === undefined ? '—' : `${n}ms`);
    this.logger.log(
      `realtime ${ccid.slice(-8)} turn timing: vad(stop→committed) ${fmt(d(o.speechStoppedAt, o.committedAt))}, ` +
        (o.toolName ? `tool ${o.toolName} ${fmt(d(o.toolStartedAt, o.toolDoneAt))}, ` : '') +
        `stop→first-audio ${fmt(d(o.speechStoppedAt, o.firstAudioAt))}, ` +
        `stop→forwarded ${fmt(d(o.speechStoppedAt, o.firstForwardedAt))}, ` +
        `stop→generated ${fmt(d(o.speechStoppedAt, o.generationDoneAt))}, ` +
        `stop→line-quiet(est) ${fmt(d(o.speechStoppedAt, o.playbackDoneAt))}`,
    );
  }

  private summariseTiming(brain: WebSocket, ccid: string): void {
    const rows = this.timingOf(brain).done;
    if (!rows.length) return;
    const pct = (xs: number[], p: number) => {
      const s = [...xs].sort((a, b) => a - b);
      return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]!;
    };
    const col = (pick: (r: TurnTiming) => number | undefined) =>
      rows.map(pick).filter((n): n is number => typeof n === 'number' && n >= 0);
    const line = (name: string, xs: number[]) =>
      xs.length
        ? `${name} p50 ${pct(xs, 50)}ms p95 ${pct(xs, 95)}ms (n=${xs.length})`
        : `${name} n=0`;
    const d = (a?: number, b?: number) => (a && b ? b - a : undefined);
    this.logger.log(
      `realtime ${ccid.slice(-8)} latency summary — ` +
        [
          line(
            'stop→first-audio',
            col((r) => d(r.speechStoppedAt, r.firstAudioAt)),
          ),
          line(
            'stop→forwarded',
            col((r) => d(r.speechStoppedAt, r.firstForwardedAt)),
          ),
          line(
            'stop→generated',
            col((r) => d(r.speechStoppedAt, r.generationDoneAt)),
          ),
          line(
            'stop→line-quiet(est)',
            col((r) => d(r.speechStoppedAt, r.playbackDoneAt)),
          ),
        ].join('; '),
    );
  }

  /** The responses currently being spoken, by id. */
  private responsesOf(brain: WebSocket): Set<string> {
    return ((brain as any).__responses ??= new Set<string>());
  }

  /** Everything we say to the model goes through here, so it can be counted. */
  private send(
    brain: WebSocket,
    frame: Record<string, unknown>,
    opts: { retryOf?: Ask; askedBy?: string } = {},
  ): void {
    const stats = this.statsOf(brain);
    if (frame.type === 'response.create') {
      // While the API is telling us to wait, nothing asks it for a reply —
      // not a tool follow-up, not a watchdog, not a check-in. Only the
      // scheduled retry gets through, and it is the one that waited.
      const blockedUntil = Number((brain as any).__createBlockedUntil ?? 0);
      if (!opts.retryOf && Date.now() < blockedUntil) {
        this.logger.warn(
          `realtime ${String((brain as any).__ccid ?? '').slice(-8)} held a reply (${String(
            (frame.response as any)?.metadata?.origin ?? 'caller',
          )}) — rate-limit cooldown for another ${blockedUntil - Date.now()}ms`,
        );
        return;
      }
      const t = this.turnsOf(brain);
      t.pendingCreates.push(
        opts.retryOf ?? {
          payload: frame,
          origin: String((frame.response as any)?.metadata?.origin ?? 'caller') as ResponseOrigin,
          attempts: 0,
          ...(opts.askedBy ? { askedBy: opts.askedBy } : {}),
        },
      );
    }
    stats.toModel += 1;
    if (frame.type === 'input_audio_buffer.append') stats.audioOut += 1;
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
    (brain as any).__toolAwaitingReply = false;
    const script = (brain as any).__pendingScript;
    const by = (brain as any).__pendingScriptBy;
    (brain as any).__pendingScript = undefined;
    (brain as any).__pendingScriptBy = undefined;
    this.speakExactly(brain, script, { askedBy: script ? by : undefined });
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
  /**
   * Ask for the next reply — and say what kind of reply it is.
   *
   * A reminder is not a turn. "Sorry, are you still there?" was sent as an
   * ordinary reply with every tool available, and the model, asked to say
   * five words, called place_order instead and put an order through on a
   * caller's silence. So a reply now carries its origin, and one that exists
   * only to speak is given no tools at all — and, belt to braces, any
   * state-changing tool it tries anyway is refused by origin.
   */
  /**
   * End the call deliberately.
   *
   * If the line has just said goodbye — the placement script ends with one —
   * nothing more is asked of the model: the line is hung up once what is
   * already playing has finished. Otherwise one scripted goodbye, speech
   * only, and the hang-up follows it; a goodbye the API refuses is not
   * retried, because the caller is leaving either way.
   */
  private closeCall(brain: WebSocket, ccid: string, script?: string): void {
    (brain as any).__closing = true;
    this.cancelRetry(brain, 'closing');
    const watch = (brain as any).__quiet;
    if (watch) clearTimeout(watch);
    (brain as any).__quiet = undefined;
    const hangIn = (ms: number) => {
      const prior = (brain as any).__hangup;
      if (prior) clearTimeout(prior);
      const t = setTimeout(() => void this.telnyx.hangup(ccid), ms);
      (t as any).unref?.();
      (brain as any).__hangup = t;
    };
    const stillPlaying = Math.max(0, this.statsOf(brain).speakingUntil - Date.now());
    const saidBye = /\b(bye|goodbye)\b/i.test(String((brain as any).__lastSaid ?? ''));
    if (saidBye && !script) {
      this.logger.log(
        `realtime ${ccid.slice(-8)} closing — goodbye already said, no further reply; hanging up in ${stillPlaying + 500}ms`,
      );
      hangIn(stillPlaying + 500);
      return;
    }
    this.logger.log(`realtime ${ccid.slice(-8)} closing — one goodbye, then hang up`);
    this.speakExactly(brain, script ?? 'Thanks for calling — bye for now.', {
      origin: 'script',
      speechOnly: true,
    });
    hangIn(stillPlaying + 6000);
  }

  private speakExactly(
    brain: WebSocket,
    script?: string,
    opts: { origin?: ResponseOrigin; speechOnly?: boolean; askedBy?: string } = {},
  ): void {
    const origin: ResponseOrigin = opts.origin ?? (script ? 'script' : 'tool');
    const speechOnly = opts.speechOnly ?? origin !== 'tool';
    const response: Record<string, unknown> = { metadata: { origin } };
    if (script) {
      response.instructions =
        `Say this to the caller, word for word, and nothing else: "${script}"` +
        (origin === 'reminder'
          ? ' Do not say that anything has been confirmed, placed, sent or done — nothing has.'
          : '');
    }
    if (speechOnly) {
      response.tools = [];
      response.tool_choice = 'none';
    }
    this.send(brain, { type: 'response.create', response }, { askedBy: opts.askedBy });
  }

  /** The model produced audio, so the line is alive. */
  private heardFromModel(brain: WebSocket): void {
    const timer = (brain as any).__quiet;
    if (timer) clearTimeout(timer);
    (brain as any).__quiet = undefined;
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
  /**
   * Where the call is, in one word — because the right response to silence
   * depends entirely on who was supposed to speak next.
   *
   * A caller who has gone quiet after "what else?" is thinking, or has put
   * the phone down: they get a reminder, then another, then a polite goodbye,
   * and their basket is in the database whichever it was. A MODEL that has
   * gone quiet after being asked for a reply is a fault, and that is what the
   * fallback engine is for. The first call on the conversation engine got the
   * second treatment for the first condition.
   */
  private phaseOf(brain: WebSocket): { phase: CallPhase; since: number } {
    return ((brain as any).__phase ??= { phase: 'WAITING_MODEL', since: Date.now() });
  }

  private setPhase(brain: WebSocket, phase: CallPhase): void {
    const p = this.phaseOf(brain);
    if (p.phase === phase) return;
    p.phase = phase;
    p.since = Date.now();
  }

  private watchForSilence(brain: WebSocket, ccid: string, mode: 'reply' | 'idle' = 'reply'): void {
    let quiet =
      mode === 'idle'
        ? Number(this.config?.get<string>('VOICE_REALTIME_IDLE_MS') ?? 10_000) || 10_000
        : Number(this.config?.get<string>('VOICE_REALTIME_QUIET_MS') ?? 3000) || 3000;
    // A person who has asked "what else?" and heard nothing says "anything
    // else?" after six or seven seconds, not ten. Ten is a phone system.
    if (mode === 'idle' && (brain as any).__mode === 'CONVERSATION') {
      quiet = Math.min(
        quiet,
        Number(this.config?.get<string>('VOICE_CONVERSATION_IDLE_MS') ?? 7000) || 7000,
      );
    }
    // Wait until the line has actually stopped talking before starting to
    // count: "are you still there?" once arrived while the caller was still
    // listening to the greeting.
    const stillSpeaking = Math.max(0, this.statsOf(brain).speakingUntil - Date.now());
    const timer = (brain as any).__quiet;
    if (timer) clearTimeout(timer);
    // Where the line stood when the wait began, so the wait can be described
    // afterwards in the two numbers that tell "no audio" from "audio, no
    // speech": frames the line delivered, and seconds loud with no detection.
    const meterAtStart = (brain as any).__meter as InboundMeter | undefined;
    const mark = {
      frames: this.statsOf(brain).audioOut,
      undetected: meterAtStart?.totals.loudUndetected ?? 0,
    };
    const timer2 = setTimeout(() => {
      (brain as any).__quiet = undefined;
      if (brain.readyState !== WebSocket.OPEN) return;
      if ((brain as any).__closing) return;
      const stats = this.statsOf(brain);
      const since = Date.now() - stats.lastEventAt;
      const meter = (brain as any).__meter as InboundMeter | undefined;
      const line = {
        framesIn: stats.audioOut - mark.frames,
        deafSeconds: (meter?.totals.loudUndetected ?? 0) - mark.undetected,
      };
      const picture =
        `phase ${this.phaseOf(brain).phase}, last "${stats.lastType}" ${since}ms ago, ` +
        `${stats.fromModel} in / ${stats.toModel} out, audio ${stats.audioIn} in / ${stats.audioOut} out, ` +
        `line ${line.framesIn} frames in / ${line.deafSeconds}s loud-undetected this wait, ` +
        `socket ${brain.readyState}, pong ${stats.pongAt ? `${Date.now() - stats.pongAt}ms ago` : 'never'}`;
      // A reply in flight IS the line working. Wait for it.
      if (this.responsesOf(brain).size > 0 && since < quiet) {
        this.watchForSilence(brain, ccid, mode);
        return;
      }

      const phase = this.phaseOf(brain).phase;
      if (phase === 'WAITING_CALLER' || phase === 'LISTENING') {
        // The caller's silence is not a fault and never a reason to change
        // engine. But two things look exactly like it from here and are not
        // it, and each is a fault: no audio reaching us at all, and audio
        // reaching us — loud — that the detector never once heard. A caller
        // in either is talking to a deaf line; the other engine listens
        // through a different path. Judged over two waits, never one, so a
        // single early meter window cannot move a call.
        const n = ((brain as any).__callerSilences = ((brain as any).__callerSilences ?? 0) + 1);
        const dead = ((brain as any).__deadWindows =
          line.framesIn === 0 ? ((brain as any).__deadWindows ?? 0) + 1 : 0);
        const deaf = ((brain as any).__deafSeconds =
          ((brain as any).__deafSeconds ?? 0) + line.deafSeconds);
        if (n >= 2 && dead >= 2) {
          this.logger.error(
            `realtime ${ccid.slice(-8)} no inbound audio from the line across two waits — not the caller's silence. Handing over (${picture})`,
          );
          void this.fallbackToRelay(ccid, { alreadySpoke: true });
          return;
        }
        if (n >= 2 && deaf >= 2) {
          this.logger.error(
            `realtime ${ccid.slice(-8)} the line was loud for ${deaf}s and the detector heard none of it — the caller may be talking to a deaf line. Handing over (${picture})`,
          );
          void this.fallbackToRelay(ccid, { alreadySpoke: true });
          return;
        }
        if (n === 1) {
          this.logger.log(`realtime ${ccid.slice(-8)} caller quiet — checking in (${picture})`);
          this.speakExactly(brain, 'Sorry, are you still there?', {
            origin: 'reminder',
            speechOnly: true,
          });
          this.watchForSilence(brain, ccid, 'idle');
          return;
        }
        if (n === 2) {
          this.logger.log(`realtime ${ccid.slice(-8)} caller still quiet — one more`);
          this.speakExactly(brain, "Hello? I'm still here whenever you're ready.", {
            origin: 'reminder',
            speechOnly: true,
          });
          this.watchForSilence(brain, ccid, 'idle');
          return;
        }
        // Three silences is a phone on a table. Say goodbye like a person
        // would and put the line down; whatever was in the basket is saved.
        this.logger.warn(`realtime ${ccid.slice(-8)} caller gone — ending the call politely`);
        this.speakExactly(
          brain,
          "I'll let you go — call back any time and I'll pick up where we left off. Bye for now.",
          { origin: 'reminder', speechOnly: true },
        );
        const goodbye = setTimeout(() => void this.telnyx.hangup(ccid), 6000);
        (goodbye as any).unref?.();
        return;
      }

      // A reply the API told us to wait for is not a stall. On aqbbdSDA a
      // retry was due in 8.5s and the watchdog, counting the wait as silence,
      // handed the call over 3s before it would have fired. One recovery
      // deadline: the retry's. It hands over itself when its budget is spent.
      {
        const blockedFor = Number((brain as any).__createBlockedUntil ?? 0) - Date.now();
        if ((brain as any).__retryTimer || blockedFor > 0) {
          this.logger.warn(
            `realtime ${ccid.slice(-8)} a retry is scheduled (cooldown ${Math.max(0, blockedFor)}ms more) — the watchdog stands back (${picture})`,
          );
          const again = setTimeout(
            () => this.watchForSilence(brain, ccid, mode),
            Math.max(0, blockedFor) + 250,
          );
          (again as any).unref?.();
          (brain as any).__quiet = again;
          return;
        }
      }

      // Waiting on the model, or on a tool. This is where a stall is a fault.
      const n = ((brain as any).__modelStalls = ((brain as any).__modelStalls ?? 0) + 1);
      if (n === 1) {
        this.logger.warn(
          `realtime ${ccid.slice(-8)} nothing came back — asking again (${picture})`,
        );
        if (this.responsesOf(brain).size > 0) {
          this.logger.warn(
            `realtime ${ccid.slice(-8)} a reply was left half-finished — cancelling it`,
          );
          this.interrupt(brain);
        }
        this.speakExactly(
          brain,
          'Sorry, I lost you there for a second. Where would you like to start — shall I take the order from the top?',
          { origin: 'reminder', speechOnly: true },
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
    }, quiet + stillSpeaking);
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
    const type = String(event?.type ?? '');
    const stats = this.statsOf(brain);
    stats.fromModel += 1;
    stats.lastEventAt = Date.now();
    stats.lastType = type;

    switch (type) {
      // GA renamed this. Both spellings are accepted so a rename in either
      // direction cannot silence the line.
      case 'response.output_audio.delta':
      case 'response.audio.delta': {
        if (!event.delta) return;
        const t = this.turnsOf(brain);
        const responseId = String(event.response_id ?? '');
        // Late audio from a cancelled response. Dropped by WHICH response it
        // belongs to, so the next reply's first frames are never dropped
        // with it.
        if (responseId && t.cancelled.has(responseId)) return;
        // No id to judge by and nothing being generated: that is a tail from
        // whatever was cancelled, by elimination.
        if (!responseId && this.responsesOf(brain).size === 0 && t.cancelled.size > 0) return;
        this.statsOf(brain).audioIn += 1;
        this.heardFromModel(brain);
        // Audio flowed, so whichever response it belongs to is not empty. A
        // frame with no id is credited to every active response — erring
        // towards "somebody spoke", because the alternative is nudging over
        // the top of a reply that is playing.
        if (responseId) t.voiced.add(responseId);
        else for (const id of this.responsesOf(brain)) t.voiced.add(id);
        this.setPhase(brain, 'PLAYING');
        const tm = this.timingOf(brain).open;
        if (tm && !tm.firstAudioAt) {
          tm.firstAudioAt = Date.now();
          tm.responseId = responseId;
        }
        // Where this item will sit on the phone line: it starts playing when
        // whatever is queued ahead of it finishes. Recorded BEFORE sendAudio
        // advances the queue.
        const itemId = String(event.item_id ?? '');
        if (itemId) {
          const bytes = Buffer.from(String(event.delta), 'base64').length;
          const ms = (bytes / 8000) * 1000;
          let a = t.audio.get(itemId);
          if (!a) {
            a = {
              responseId,
              contentIndex: Number(event.content_index ?? 0) || 0,
              startsAt: Math.max(Date.now(), this.statsOf(brain).speakingUntil),
              totalMs: 0,
            };
            t.audio.set(itemId, a);
          }
          a.totalMs += ms;
          t.currentAudio = itemId;
        }
        sendAudio(event.delta);
        if (tm && !tm.firstForwardedAt) tm.firstForwardedAt = Date.now();
        return;
      }

      // session.created arrives the instant the socket opens, carrying the
      // DEFAULTS — 24kHz PCM. Greeting on it sent 24kHz audio down an 8kHz
      // μ-law phone line, which is silence with extra steps. Only
      // session.updated means our settings were accepted.
      case 'session.created':
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
      case 'response.created': {
        const id = String(event.response?.id ?? `r${Date.now()}`);
        this.responsesOf(brain).add(id);
        // The words the caller had said BEFORE this reply started are the
        // ones a tool inside it may act on — however the model orders its
        // own speech and its tool calls within the reply.
        this.turnsOf(brain).responseAskSeq.set(id, this.turnsOf(brain).askSeq);
        const origin = String(event.response?.metadata?.origin ?? 'caller') as ResponseOrigin;
        this.turnsOf(brain).originOf.set(id, origin);
        {
          const t = this.turnsOf(brain);
          // Ours, in order — or the server's own, for a caller turn.
          const ask =
            origin === 'caller' && !t.pendingCreates.length
              ? { payload: null, origin, attempts: 0 }
              : (t.pendingCreates.shift() ?? { payload: null, origin, attempts: 0 });
          t.asks.set(id, ask);
        }
        this.logger.log(
          `realtime ${ccid.slice(-8)} reply ${id.slice(-8)} created at askSeq ${this.turnsOf(brain).askSeq} (${origin})`,
        );
        (brain as any).__modelStalls = 0;
        this.setPhase(brain, 'WAITING_MODEL');
        return;
      }

      // A transcript is on its way. Consent-critical tools wait for it rather
      // than deciding on the last caller's words.
      case 'conversation.item.input_audio_transcription.delta':
        (brain as any).__transcribing = true;
        return;

      // Remaining budget, from the API's own accounting. The number that
      // explains a whole call's worth of failures before the first one.
      case 'rate_limits.updated': {
        const lims: any[] = Array.isArray(event.rate_limits) ? event.rate_limits : [];
        const line = lims
          .map(
            (l) =>
              `${l.name} ${l.remaining ?? '?'}/${l.limit ?? '?'} (reset ${l.reset_seconds ?? '?'}s)`,
          )
          .join(', ');
        const tokens = lims.find((l) => l.name === 'tokens');
        const prev = (brain as any).__tokensRemaining;
        (brain as any).__tokensRemaining = tokens?.remaining;
        const cost =
          typeof prev === 'number' && typeof tokens?.remaining === 'number' && tokens.remaining < prev
            ? ` — budget moved ≈ ${prev - tokens.remaining} tokens (estimate; see usage)`
            : '';
        if (line) this.logger.log(`realtime ${ccid.slice(-8)} rate limits: ${line}${cost}`);
        return;
      }

      case 'response.done': {
        // The line has stopped talking. Whatever happens next — the caller
        // answering, a tool, nothing at all — somebody is now waiting, and
        // until this the watchdog was armed ONLY by a transcript arriving or a
        // tool running. On 6 September neither happened: the line asked
        // "would you like the same as last time?", the caller said no, and
        // there is not one line in the log after that. Nothing was watching,
        // so nothing recovered, and the call died in silence.
        {
          // A reply with nothing in it — no audio, no tool call — is the
          // model declining to speak, not the caller thinking. Seen after
          // order_confirmed: the tool said "now ask how they'd like to pay",
          // the model returned an empty response, and the caller sat through
          // ten seconds of idle-timer before being asked. That is a stall and
          // gets the short clock.
          const t = this.turnsOf(brain);
          const rid = String(event.response?.id ?? '');
          const hadAudio = t.voiced.has(rid);
          const hadTool = t.toolResponses.has(rid);
          this.logger.log(
            `realtime ${ccid.slice(-8)} reply ${rid.slice(-8)} done: status ${event.response?.status ?? '?'}, audio ${hadAudio}, tool ${hadTool}`,
          );
          // What this reply cost, from the response itself. The remaining-
          // budget delta logged with rate_limits.updated is an estimate that
          // moves with every reply in flight; this is the number.
          if ((brain as any).__closing && String(event.response?.status ?? '') === 'completed') {
            // The goodbye is generated; it plays out for a little longer.
            const prior = (brain as any).__hangup;
            if (prior) clearTimeout(prior);
            const wait = Math.max(0, this.statsOf(brain).speakingUntil - Date.now()) + 500;
            const t = setTimeout(() => void this.telnyx.hangup(ccid), wait);
            (t as any).unref?.();
            (brain as any).__hangup = t;
            this.logger.log(`realtime ${ccid.slice(-8)} goodbye said — hanging up in ${wait}ms`);
          }
          const u = event.response?.usage;
          if (u && typeof u.total_tokens === 'number' && u.total_tokens > 0) {
            const i = u.input_token_details ?? {};
            const o = u.output_token_details ?? {};
            this.logger.log(
              `realtime ${ccid.slice(-8)} reply ${rid.slice(-8)} usage: ${u.total_tokens} tokens — ` +
                `in ${u.input_tokens ?? '?'} (text ${i.text_tokens ?? '?'}, audio ${i.audio_tokens ?? '?'}, cached ${i.cached_tokens ?? 0}), ` +
                `out ${u.output_tokens ?? '?'} (text ${o.text_tokens ?? '?'}, audio ${o.audio_tokens ?? '?'})`,
            );
          }
          const status = String(event.response?.status ?? '');
          const cancelled = status === 'cancelled';
          if (status === 'failed' || status === 'incomplete') {
            // Sixty-one retries in one call. The first version keyed "retry
            // once" on the FAILED reply's id, and every retry is a new reply
            // with a new id — so the guard never matched, and a line that was
            // being told to back off was hit every 180ms instead. The budget
            // now belongs to the ASK: the response.create that started it,
            // carried through each retry. And a rate limit is a wait, not a
            // fault: the reset the API names is honoured, with backoff and
            // jitter on top, by every reply path at once.
            const d = event.response?.status_details ?? {};
            const message = String(d.error?.message ?? '');
            this.logger.error(
              `realtime ${ccid.slice(-8)} reply ${rid.slice(-8)} ${status}: type=${d.type ?? '?'} reason=${d.reason ?? '?'} ` +
                `code=${d.error?.code ?? '?'} message=${message.slice(0, 400)}`,
            );
            this.responsesOf(brain).delete(rid);
            this.retryAsk(brain, ccid, rid, String(d.error?.code ?? ''), message);
            return;
          }
          if (rid && !hadAudio && !hadTool && !cancelled && status !== 'failed') {
            this.logger.warn(
              `realtime ${ccid.slice(-8)} empty reply ${rid.slice(-8)} — treating as a stall`,
            );
            this.watchForSilence(brain, ccid, 'reply');
          } else if (hadTool && !hadAudio) {
            // The tool's own reply is on its way. Not the caller's turn yet.
            this.setPhase(brain, 'WAITING_MODEL');
            this.watchForSilence(brain, ccid, 'reply');
          } else {
            this.setPhase(brain, 'WAITING_CALLER');
            this.watchForSilence(brain, ccid, 'idle');
          }
        }
        {
          const tm = this.timingOf(brain).open;
          // A reply that only called a tool has not answered the caller yet;
          // the timing stays open for the spoken continuation. Closing it
          // here measured the tool turn at 428ms and never measured the
          // "Got it…" that the caller actually waited for.
          if (
            tm &&
            !tm.generationDoneAt &&
            this.turnsOf(brain).voiced.has(String(event.response?.id ?? ''))
          ) {
            tm.generationDoneAt = Date.now();
            tm.playbackDoneAt = Math.max(Date.now(), this.statsOf(brain).speakingUntil);
            this.closeTurnTiming(brain, ccid);
          }
        }
        const running = this.responsesOf(brain);
        const id = String(event.response?.id ?? '');
        if (id && running.has(id)) running.delete(id);
        else running.delete(running.values().next().value ?? '');
        if (running.size === 0) this.flushPending(brain);
        return;
      }

      // What the line actually SAID. Without it, "it went silent" is a report
      // that cannot be told apart from "it spoke and the audio never arrived",
      // and those have completely different causes.
      case 'response.output_audio_transcript.done': {
        // We have finished saying something. Whatever the caller says next is
        // in answer to THIS, and whatever they said before it was not.
        const t = this.turnsOf(brain);
        t.askSeq += 1;
        const by = t.asks.get(String(event.response_id ?? ''))?.askedBy;
        if (by) {
          t.askedFor.set(by, t.askSeq);
          if (ASKS_AS[by]) t.askedFor.set(ASKS_AS[by]!, t.askSeq);
        }
        if (event.transcript) {
          (brain as any).__lastSaid = String(event.transcript);
          this.logger.log(
            // The whole read-back, with its length: a line that ends at 200
            // characters is the log's doing, not the audio's.
            `realtime ${ccid.slice(-8)} said ${JSON.stringify(String(event.transcript).trim().slice(0, 600))} (${String(event.transcript).trim().length} chars)`,
          );
        }
        return;
      }
      case 'session.updated': {
        // What the server ACCEPTED, not what was asked for. The ready line
        // below prints our request; a threshold quietly overridden by a
        // runtime setting would otherwise be invisible.
        const accepted =
          event.session?.audio?.input?.turn_detection ?? event.session?.turn_detection;
        if (accepted) {
          this.logger.log(
            `realtime ${ccid.slice(-8)} server accepted turn_detection ${JSON.stringify(accepted)}`,
          );
        }
        (brain as any).__onConfigured?.();
        return;
      }

      // The caller's own words, logged in the same shape the chained engine
      // logs them. Without this the two engines cannot be compared, and a bad
      // call on this one could not be diagnosed at all.
      // VAD says they have stopped talking. From here the line OWES them a
      // reply, and it is on the short clock — earlier and more reliable than
      // waiting for a transcript, which on the call above never came.
      // They started talking. Stop, the way a person would — the model
      // cancels its own reply server-side, but the audio already at Telnyx
      // would carry on over the top of them.
      case 'input_audio_buffer.speech_started':
        // The server cancels its own reply on this; the truncation and the
        // Telnyx queue are ours to deal with, and they are the same job a
        // keypress does.
        // Logged, because without it a caller who spoke and was not heard
        // is indistinguishable from one who said nothing: both are thirteen
        // seconds of no events and then "are you still there?".
        this.logger.log(`realtime ${ccid.slice(-8)} caller started speaking`);
        (brain as any).__callerSilences = 0;
        (brain as any).__deadWindows = 0;
        (brain as any).__deafSeconds = 0;
        ((brain as any).__meter as InboundMeter | undefined)?.speechDetected();
        this.setPhase(brain, 'LISTENING');
        this.interrupt(brain, { serverCancels: true });
        return;

      case 'input_audio_buffer.speech_stopped': {
        const tm = this.timingOf(brain);
        tm.open = { speechStoppedAt: Date.now() };
        this.logger.log(`realtime ${ccid.slice(-8)} caller stopped speaking`);
        ((brain as any).__meter as InboundMeter | undefined)?.speechEnded();
        this.setPhase(brain, 'WAITING_MODEL');
        this.watchForSilence(brain, ccid, 'reply');
        return;
      }

      // The caller's turn is now a conversation item, in order. This is where
      // it gets stamped with the question it answers — its transcript may
      // arrive any time later, and possibly after a newer turn's.
      case 'input_audio_buffer.committed': {
        const t = this.turnsOf(brain);
        const itemId = String(event.item_id ?? '');
        if (itemId && !t.heard.has(itemId)) {
          t.heard.set(itemId, { askSeq: t.askSeq, committedAt: Date.now(), spoke: true });
          t.order.push(itemId);
        }
        const tm = this.timingOf(brain);
        if (tm.open && !tm.open.committedAt) tm.open.committedAt = Date.now();
        this.logger.log(
          `realtime ${ccid.slice(-8)} caller turn committed item=${itemId || '?'} askSeq=${t.askSeq}`,
        );
        // The caller has moved on; a retry of what we were about to say to
        // them is stale. The server will reply to their turn.
        this.cancelRetry(brain, 'caller spoke');
        (brain as any).__callerSilences = 0;
        this.setPhase(brain, 'WAITING_MODEL');
        this.watchForSilence(brain, ccid, 'reply');
        return;
      }

      case 'conversation.item.input_audio_transcription.completed': {
        // Kept, because a tool sometimes has to be held to what the caller
        // actually said rather than to what the model believes they meant.
        const heard = String(event.transcript ?? '').trim();
        const t = this.turnsOf(brain);
        // An event with no item id still happened. Filed under a synthetic id
        // so it is never lost — and never mistaken for a different turn.
        const itemId =
          String(event.item_id ?? '') ||
          `anon-${((brain as any).__anonSeq = ((brain as any).__anonSeq ?? 0) + 1)}`;
        (brain as any).__transcribing = false;
        this.logger.log(`realtime ${ccid.slice(-8)} heard ${JSON.stringify(heard)}`);

        // A person spoke if there is a letter in ANY alphabet — or a digit.
        //
        //   said  "For your select pizza size, press 1 for 10", 2 for 12"…"
        //   heard "12"
        //
        // The letters-only test read that as background noise and told the
        // model the caller had not answered. Numbers are the most reliable
        // thing a transcriber returns, not the least.
        const spoke = /[\p{L}\p{N}]/u.test(heard);
        const readable = /[a-z0-9]/i.test(heard);

        // Filed against the turn it belongs to, which may not be the newest.
        // A transcript arriving late does not become the answer to a question
        // asked after it was said.
        let rec = itemId ? t.heard.get(itemId) : undefined;
        if (itemId && !rec) {
          // Completed before committed — seen, and legal. Stamp it with the
          // question in force now; nothing better is known.
          rec = { askSeq: t.askSeq, committedAt: Date.now(), spoke: true };
          t.heard.set(itemId, rec);
          t.order.push(itemId);
        }
        if (rec) {
          rec.text = heard;
          rec.readable = readable;
          rec.spoke = rec.spoke || spoke;
        }

        // Non-Latin is MANGLED SPEECH, not silence.
        //
        //   said "Would you like the same as last time…?"
        //   heard "Svensk."           ← the caller said no
        //   heard "Телигов."          ← the caller said yes
        //
        // The sidecar transcriber is a small model on 8kHz phone audio and it
        // guesses a language per utterance. The speech-to-speech model hears
        // the real audio and got both of those right.
        if (spoke && !readable) {
          this.logger.warn(
            `realtime ${ccid.slice(-8)} heard speech the transcriber could not render — letting the model answer it`,
          );
          this.watchForSilence(brain, ccid);
          return;
        }

        // NO WORDS came back.
        //
        // That is not proof the caller said nothing. The audio was committed
        // because the voice detector heard speech; the transcriber then
        // returned nothing for it, which it does on a breath — and also on a
        // short word over a bad line. The model heard the audio itself and is
        // the only party that can tell those apart. So it is told exactly what
        // happened, and it decides; what it may NOT do is treat the empty
        // string as a yes, which is the mistake this guard was born from.
        if (!spoke) {
          this.logger.warn(
            `realtime ${ccid.slice(-8)} the transcriber returned nothing for that turn`,
          );
          this.send(brain, {
            type: 'conversation.item.create',
            item: {
              type: 'message',
              role: 'user',
              content: [
                {
                  type: 'input_text',
                  text: '(The transcriber returned no words for what was just heard. If you understood them, answer that. If it was only a noise, or you are not sure, ask them to say it again. It was NOT a yes.)',
                },
              ],
            },
          });
          this.watchForSilence(brain, ccid, 'idle');
          return;
        }
        // A question the walkthrough asked, answered out loud.
        //
        // The keypad had this route and speech did not, which lost a whole
        // pizza: "Any notes for the gran duca? Say it now, or press 1 if not."
        // — the caller said "No", nothing consumed it, the item never
        // committed, and the model (told the item was being handled in code)
        // said nothing at all until the watchdog fired ten seconds later.
        // Held in a variable first. `a?.b().then()` short-circuits the WHOLE
        // chain when the method is missing, which would skip the line below
        // and leave nothing watching the call — the one thing that must never
        // happen is silence.
        // The conversation engine has no walkthrough to answer. The model
        // has the turn; the clock starts.
        if ((brain as any).__mode === 'CONVERSATION') {
          this.watchForSilence(brain, ccid);
          return;
        }
        const answering = this.voice.realtimeSaid?.(ccid, heard);
        if (!answering) {
          this.watchForSilence(brain, ccid);
          return;
        }
        void answering
          .then((answered: { say: string; owned?: boolean } | null) => {
            if (!answered?.say) {
              // Not ours. If code held the turn, the server did not create a
              // reply — so the hand-over to the model is explicit, not hoped
              // for. Then the clock starts.
              if ((brain as any).__codeOwnsTurn) {
                this.setTurnOwner(brain, false);
                this.send(brain, { type: 'response.create' });
              }
              this.watchForSilence(brain, ccid);
              return;
            }
            this.interrupt(brain);
            this.send(brain, {
              type: 'conversation.item.create',
              item: {
                type: 'message',
                role: 'user',
                content: [
                  {
                    type: 'input_text',
                    text: `They answered the question you asked, out loud, and it has ALREADY been applied to the order — you will say "${answered.say}" next. Do not call add_item, and do not ask that question again.`,
                  },
                ],
              },
            });
            this.speakExactly(brain, answered.say);
            this.setTurnOwner(brain, answered.owned === true);
          })
          .catch(() => this.watchForSilence(brain, ccid));
        return;
      }

      // GA can deliver a finished tool call either way round. Handling only
      // one of them would look exactly like a model that never calls tools.
      // GA emits BOTH of these for the SAME tool call — I handled both on the
      // assumption one had replaced the other, so every tool ran twice, two
      // outputs came back under one call_id, and two responses were asked for
      // at once. The second collided with the first and the line went silent
      // mid-order. Once per call_id, whichever event announces it first.
      case 'response.output_item.done':
      case 'response.function_call_arguments.done': {
        const item = event.item ?? {};
        if (type === 'response.output_item.done' && item.type !== 'function_call') return;
        const name = String(event.name ?? item.name ?? '');
        const callId = String(event.call_id ?? item.call_id ?? '');
        const handled: Set<string> = ((brain as any).__handledTools ??= new Set<string>());
        if (!callId || handled.has(callId)) {
          if (callId) this.logger.log(`realtime ${ccid.slice(-8)} ignored a repeat of ${name}`);
          return;
        }
        handled.add(callId);
        this.logger.log(`realtime ${ccid.slice(-8)} calling ${name}`);

        // Three tools turn a yes into food in a kitchen. On the call that
        // prompted this, use_usual ran 248ms BEFORE the transcript of the
        // answer it was acting on arrived — so the words it would have been
        // judged against were the previous caller turn, or nothing at all.
        // Wait for the sentence that is already being written down.
        const conversation = (brain as any).__mode === 'CONVERSATION';
        // A reply that exists only to speak does not get to act. The tools
        // were withheld from it; if one arrives anyway, it is refused here.
        {
          const origin = this.turnsOf(brain).originOf.get(String(event.response_id ?? ''));
          if (
            (origin === 'reminder' || origin === 'greeting' || origin === 'script') &&
            STATE_CHANGING.has(name)
          ) {
            this.logger.warn(
              `realtime ${ccid.slice(-8)} refused ${name} from a ${origin} reply — nothing the caller said asked for it`,
            );
            brain.send(
              JSON.stringify({
                type: 'conversation.item.create',
                item: {
                  type: 'function_call_output',
                  call_id: callId,
                  output:
                    'Refused: this reply was only meant to speak, not to change the order. Wait for the caller to answer.',
                },
              }),
            );
            return;
          }
        }
        this.setPhase(brain, 'WAITING_TOOL');
        {
          const tm = this.timingOf(brain).open;
          if (tm && !tm.toolStartedAt) {
            tm.toolStartedAt = Date.now();
            tm.toolName = name;
          }
        }
        if (!conversation && NEEDS_CONSENT.has(name)) await this.waitForTranscript(brain);
        let args: any = {};
        try {
          args = JSON.parse(event.arguments ?? item.arguments ?? '{}');
        } catch {
          /* the model sent something unparseable; the tool decides */
        }
        // The caller's words this tool may act on: the newest committed turn,
        // judged against the question in force when THIS response started,
        // and never a turn a previous consent decision already spent.
        const t = this.turnsOf(brain);
        const latest = this.latestHeard(brain);
        const responseId = String(event.response_id ?? '');
        const askedAt = t.responseAskSeq.get(responseId) ?? t.askSeq;
        if (responseId) t.toolResponses.add(responseId);
        // Did the caller SPEAK after the question this reply is acting on?
        // From the committed audio turn, not its transcript — the evidence a
        // yes needs on this engine is that a turn happened, not what the
        // transcriber made of it.
        // A consent tool answers a scripted question. Its evidence is the
        // FIRST unspent turn after that question — the caller's answer to
        // it — never whatever they said most recently to something else.
        // Every other tool is judged against the newest turn, as before.
        const question = ANSWERS[name];
        const askedFrom = question ? t.askedFor.get(question) : undefined;
        const firstAfter =
          askedFrom === undefined
            ? undefined
            : t.order.find((id) => {
                const h = t.heard.get(id);
                return !!h && h.askSeq >= askedFrom && !t.consumed.has(id);
              });
        const lastTurnId = firstAfter ?? t.order[t.order.length - 1];
        const lastTurn = lastTurnId ? t.heard.get(lastTurnId) : undefined;
        const since = firstAfter ? (askedFrom as number) : askedAt;
        const spokeAfterQuestion =
          !!lastTurnId && !!lastTurn && lastTurn.askSeq >= since && !t.consumed.has(lastTurnId);
        const out = await (
          conversation
            ? this.voice.conversationTool(ccid, name, {
                ...args,
                __conversation: true,
                __spokeAfterQuestion: spokeAfterQuestion,
                // The words of that turn, when the transcriber has them —
                // never the proof of a yes, but enough to refuse a plain no.
                __heard: spokeAfterQuestion ? (lastTurn?.text ?? null) : null,
              })
            : this.voice.realtimeTool(ccid, name, {
                ...args,
                __heard: latest?.text ?? null,
                __heardItemId: latest?.itemId ?? null,
                // Said in answer to the current question — not merely after we
                // last spoke, and not already used to decide something else.
                __heardFresh:
                  !!latest && latest.askSeq >= askedAt && !t.consumed.has(latest.itemId),
                // Whether those words are worth reading at all. "Svensk." is not a
                // no — it is a transcriber that lost the language, and a consent
                // check that reads it as a refusal asks the same question forever.
                __heardReadable: latest?.readable !== false,
              })
        ).catch((e: any) => ({ result: `That failed: ${e?.message ?? e}`, turn: undefined }));
        // Everything below this point must survive a tool that answered oddly.
        // A thrown TypeError here would skip the output AND the reply, which
        // the caller experiences as the line simply stopping.
        const said = typeof out?.result === 'string' && out.result ? out.result : 'Done.';
        this.logger.log(`realtime ${ccid.slice(-8)} tool ${name} → ${said.slice(0, 120)}`);
        // Spent. The same "yes" cannot confirm two different things.
        if (
          NEEDS_CONSENT.has(name) ||
          (conversation && (name === 'place_order' || name === 'amend_order'))
        ) {
          const spent = conversation ? lastTurnId : latest?.itemId;
          if (spent) t.consumed.add(spent);
        }
        {
          const tm = this.timingOf(brain).open;
          if (tm && tm.toolStartedAt && !tm.toolDoneAt) tm.toolDoneAt = Date.now();
        }
        this.setPhase(brain, 'WAITING_MODEL');
        brain.send(
          JSON.stringify({
            type: 'conversation.item.create',
            item: {
              type: 'function_call_output',
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
        if (typeof (out as any)?.owned === 'boolean') this.setTurnOwner(brain, (out as any).owned);
        // A call that is ending gets no ordinary follow-up reply and no
        // recovery. On call laylhxjw end_call asked the model for one more
        // reply, the API refused it for rate, and a retry was scheduled for a
        // caller who had already said goodbye and hung up.
        if (out?.turn?.endCall) {
          this.closeCall(brain, ccid, script);
          return;
        }
        if (this.responsesOf(brain).size > 0) {
          (brain as any).__responsePending = true;
          (brain as any).__toolAwaitingReply = true;
          if (script) {
            (brain as any).__pendingScript = script;
            (brain as any).__pendingScriptBy = String((out as any)?.askedBy ?? name);
          }
        } else {
          this.speakExactly(brain, script, {
            askedBy: script ? String((out as any)?.askedBy ?? name) : undefined,
          });
        }
        // A tool answer that produces no speech is the same silence by another
        // route, so the clock runs on this too.
        this.watchForSilence(brain, ccid);

        // Telephony stays out of VoiceService — that is what lets both engines
        // share it — so the two side effects a tool can have are done here.
        if (out?.turn?.transferTo) {
          setTimeout(() => void this.telnyx.transfer(ccid, out.turn!.transferTo!), 3000);
        }
        return;
      }

      case 'error': {
        const err = event.error ?? event;
        const text = JSON.stringify(err);
        // A rejected audio format is recoverable — try the next spelling
        // rather than leaving the caller on a line that cannot speak.
        if (
          /format/i.test(text) &&
          (brain as any).__retryFormat?.(String(err?.message ?? '').slice(0, 120))
        ) {
          return;
        }
        // Same idea for turn detection: a rejected setting is recoverable, and
        // a caller should never pay for us having asked for something new.
        if (
          /turn_detection|semantic_vad|eagerness/i.test(text) &&
          (brain as any).__retryTurnDetection?.(String(err?.message ?? '').slice(0, 120))
        ) {
          return;
        }
        // "Conversation already has an active response." Nothing acted on
        // this, and because the line only ever speaks when asked to, the one
        // refusal was the end of the call. Ask again the moment the response
        // that was in the way finishes.
        if (/active_response|already has an active/i.test(text)) {
          // Queued ONLY when a tool is waiting to be spoken about.
          //
          // A refused nudge must be dropped, not saved for later: the reply it
          // collided with is the line working, and flushing the nudge
          // afterwards makes the model answer a question the caller never
          // asked. That is what put "No problem, let's start a fresh order"
          // into a call one and a half seconds after "would you like the same
          // as last time?".
          if ((brain as any).__toolAwaitingReply && this.responsesOf(brain).size > 0) {
            this.logger.warn(
              `realtime ${ccid.slice(-8)} reply refused as one was already running — queued`,
            );
            (brain as any).__responsePending = true;
          } else {
            this.logger.warn(
              `realtime ${ccid.slice(-8)} reply refused as one was already running — dropped`,
            );
          }
          return;
        }
        this.logger.error(`realtime model error on ${ccid.slice(-8)}: ${text.slice(0, 400)}`);

        if (/insufficient_quota|credit_balance_exhausted|billing/i.test(text)) {
          const minutes =
            Number(this.config.get<string>('VOICE_REALTIME_STAND_DOWN_MINUTES') ?? 10) || 10;
          this.standDown = {
            until: Date.now() + minutes * 60_000,
            why: `the OpenAI account has no credits (${String(err?.code ?? err?.type ?? 'insufficient_quota')}) — standing down for ${minutes} minutes; top up at platform.openai.com`,
          };
          this.logger.error(`realtime ${this.standDown.why}`);
        }

        // A session we asked for and were refused is not going to be accepted
        // by waiting. Until the readiness timer was the only thing watching
        // this, a caller sat in silence for five more seconds after OpenAI had
        // already said no — on a call where the greeting had not been spoken
        // yet, so all they heard was a shop that did not answer its phone.
        if (!(brain as any).__configured?.() && /session\./.test(String(err?.param ?? ''))) {
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
