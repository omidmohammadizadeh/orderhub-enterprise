import { Injectable, Logger, OnModuleInit } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { HttpAdapterHost } from "@nestjs/core";
import { createHmac, timingSafeEqual } from "crypto";
import type { IncomingMessage } from "http";
import type { Duplex } from "stream";
import { WebSocketServer, type WebSocket } from "ws";
import { PrismaService } from "../../infrastructure/database/prisma.service";
import { VoiceService } from "./voice.service";
import { TelnyxCallControlService } from "./telnyx-call-control.service";

// Conversation Relay — the same call, without the beat.
//
// The webhook line works, and it is why the ordering brain, the tools, the
// read-back locks and the billing below this file do not change by a single
// line. What it cannot do is feel fast. Every turn is a separate HTTP request,
// so the floor is roughly:
//
//   Telnyx decides the caller stopped   0.5–1.0s
//   our settle timer                    0.4–1.5s
//   the model, start to finish          2.0–5.0s
//   speech generated, playback begins   ~0.3s
//
// Nothing tuned inside that gets under two seconds, because the caller waits
// for the WHOLE reply to be written before hearing any of it.
//
// Conversation Relay keeps one WebSocket open for the call. Telnyx does the
// listening, the endpointing and the speaking; we exchange TEXT. Which means
// the model's first sentence can be spoken while it is still writing the
// second — time to first word stops depending on how long the answer is.
// Telnyx also handles barge-in itself, so the caller can talk over us without
// us having to notice and issue a stop.
//
// Deliberately NOT the default. It runs when VOICE_RELAY_URL is set, and the
// webhook path stays exactly where it was — a shop mid-service is not the
// place to discover that a new transport has a shape we guessed wrong. Every
// frame is logged verbatim the first time it is seen for that reason.

/** Frames Telnyx sends us. Extra fields are expected and ignored. */
interface RelayIn {
  type?: string;
  /** setup */
  callControlId?: string;
  sessionId?: string;
  from?: string;
  to?: string;
  /** prompt */
  voicePrompt?: string;
  last?: boolean;
  /** dtmf */
  digit?: string;
  /** interrupt */
  utteranceUntilInterrupt?: string;
  /** error */
  description?: string;
}

@Injectable()
export class VoiceRelayGateway implements OnModuleInit {
  private readonly logger = new Logger(VoiceRelayGateway.name);
  private wss?: WebSocketServer;
  /** call_control_id → socket, so a transfer can close the right relay. */
  private readonly sockets = new Map<string, WebSocket>();
  private readonly seenFrameTypes = new Set<string>();

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

  /** Where Telnyx should connect back to. Unset = relay off, webhooks used. */
  relayUrl(callControlId: string): string | null {
    const base = this.config.get<string>("VOICE_RELAY_URL");
    if (!base) return null;
    // The socket is a public endpoint that can talk to a caller, so it is not
    // left open to anyone who finds the URL. The token is derived from the
    // call id, so it is useless on any other call and expires with it.
    return `${base.replace(/\/+$/, "")}?call=${encodeURIComponent(
      callControlId,
    )}&t=${this.tokenFor(callControlId)}`;
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

  onModuleInit(): void {
    if (!this.config.get<string>("VOICE_RELAY_URL")) return;

    const server = this.adapterHost.httpAdapter?.getHttpServer();
    if (!server) {
      this.logger.error("No HTTP server to attach the voice relay to");
      return;
    }

    // noServer + our own upgrade listener, so socket.io keeps its own path
    // untouched. Each listener answers only for the path it owns; anything
    // else it leaves alone for the other to claim.
    this.wss = new WebSocketServer({ noServer: true });
    server.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
      let url: URL;
      try {
        url = new URL(req.url ?? "", "http://localhost");
      } catch {
        return;
      }
      if (!url.pathname.startsWith("/voice/relay")) return;

      const call = url.searchParams.get("call") ?? "";
      const token = url.searchParams.get("t") ?? "";
      if (!call || !this.validToken(call, token)) {
        this.logger.warn(`Rejected voice relay upgrade for "${call.slice(-8)}"`);
        socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
        socket.destroy();
        return;
      }

      this.wss!.handleUpgrade(req, socket, head, (ws) => this.attach(ws, call));
    });

    this.logger.log("Voice relay listening on /voice/relay");
  }

  /** Has Telnyx actually dialled us back for this call? */
  isConnected(callControlId: string): boolean {
    return this.sockets.has(callControlId);
  }

  /**
   * Telnyx accepted the start command — but did it reach us?
   *
   * A relay that starts and never connects is the one failure this design
   * cannot recover from on its own: Telnyx is holding the call, and speaking
   * over it from here would talk across whatever it is already saying. So this
   * does not try to be clever. It says so, loudly, in the one place someone
   * will be looking after a test call.
   */
  watchForConnection(callControlId: string): void {
    setTimeout(() => {
      if (this.isConnected(callControlId)) return;
      this.logger.error(
        `Conversation Relay started on ${callControlId.slice(-8)} but nothing connected to ${this.config.get<string>("VOICE_RELAY_URL")} — the caller is on a line that cannot hear them. Unset VOICE_RELAY_URL to fall back to the webhook transport.`,
      );
    }, 8000);
  }

  private attach(ws: WebSocket, callControlId: string): void {
    this.sockets.set(callControlId, ws);
    this.logger.log(`relay open for call ${callControlId.slice(-8)}`);

    ws.on("message", (raw) => {
      void this.onFrame(ws, callControlId, raw.toString());
    });
    ws.on("close", () => {
      this.sockets.delete(callControlId);
      this.logger.log(`relay closed for call ${callControlId.slice(-8)}`);
    });
    ws.on("error", (e) => {
      this.logger.warn(`relay error on ${callControlId.slice(-8)}: ${e?.message}`);
    });
  }

  private async onFrame(ws: WebSocket, ccid: string, raw: string): Promise<void> {
    let frame: RelayIn;
    try {
      frame = JSON.parse(raw);
    } catch {
      this.logger.warn(`relay ${ccid.slice(-8)} sent non-JSON: ${raw.slice(0, 200)}`);
      return;
    }

    const type = String(frame.type ?? "");
    // The first of each kind is logged whole. Docs describe this protocol;
    // only a real call proves it, and the last two transport bugs were both a
    // field in a place the docs did not say.
    if (!this.seenFrameTypes.has(type)) {
      this.seenFrameTypes.add(type);
      this.logger.log(`relay first "${type}" frame: ${raw.slice(0, 500)}`);
    }

    try {
      switch (type) {
        case "setup":
          // Nothing to do: the greeting is spoken by Telnyx from the start
          // command, and the VoiceCall row already exists from call.initiated.
          return;
        case "prompt":
          // Interim transcripts are for showing progress, not for answering.
          if (frame.last === false) return;
          return await this.onSaid(ws, ccid, String(frame.voicePrompt ?? "").trim());
        case "dtmf":
          return await this.onDigit(ws, ccid, String(frame.digit ?? ""));
        case "interrupt":
          // Telnyx has already stopped speaking. Worth a line, because a lot
          // of interruptions means our turns are too long.
          this.logger.log(
            `relay ${ccid.slice(-8)} interrupted after "${String(
              frame.utteranceUntilInterrupt ?? "",
            ).slice(0, 60)}"`,
          );
          return;
        case "error":
          this.logger.error(`relay ${ccid.slice(-8)} error: ${frame.description}`);
          return;
        default:
          return;
      }
    } catch (e: any) {
      this.logger.error(`relay ${ccid.slice(-8)} ${type} failed: ${e?.message ?? e}`);
    }
  }

  private async callIdFor(ccid: string): Promise<string | null> {
    const call = await this.db().voiceCall.findUnique({
      where: { providerCallId: ccid },
      select: { id: true },
    });
    return call?.id ?? null;
  }

  private async onSaid(ws: WebSocket, ccid: string, text: string): Promise<void> {
    if (!text) return;
    const callId = await this.callIdFor(ccid);
    if (!callId) return;

    const turn = await this.voice.onCallerSaid({
      callId,
      text,
      // Each sentence is spoken as it is written rather than after the whole
      // reply is finished. This is the entire point of the relay: time to the
      // first word stops depending on how long the answer turns out to be.
      onPartial: (chunk) => this.sayPartial(ws, chunk),
    });

    this.finish(ws, ccid, callId, turn);
  }

  private async onDigit(ws: WebSocket, ccid: string, digit: string): Promise<void> {
    if (!digit) return;
    const callId = await this.callIdFor(ccid);
    if (!callId) return;
    const turn = await this.voice.onDigit({ callId, digit });
    if (turn) this.finish(ws, ccid, callId, turn);
  }

  /** Speak a chunk now, with more to follow. */
  private sayPartial(ws: WebSocket, token: string): void {
    if (!token || ws.readyState !== ws.OPEN) return;
    ws.send(JSON.stringify({ type: "text", token, last: false }));
  }

  private async finish(
    ws: WebSocket,
    ccid: string,
    callId: string,
    turn: { say: string; endCall?: boolean; transferTo?: string; streamed?: boolean },
  ): Promise<void> {
    if (ws.readyState === ws.OPEN) {
      // A turn answered off the model path (a menu choice, a yes to a
      // read-back) was never streamed, so it is sent whole. One that WAS
      // streamed only needs the closing marker.
      ws.send(
        JSON.stringify({
          type: "text",
          token: turn.streamed ? "" : turn.say,
          last: true,
        }),
      );
    }

    if (turn.transferTo) {
      await this.db().voiceCall.update({
        where: { id: callId },
        data: { status: "TRANSFERRED", outcome: "TRANSFERRED" },
      });
      // End the relay before transferring, or Telnyx is holding the leg we
      // are trying to hand to a person.
      this.end(ws, "transfer");
      if (!(await this.telnyx.transfer(ccid, turn.transferTo))) {
        await this.telnyx.speak(
          ccid,
          "Sorry, I can't put you through right now. Please call the shop back in a moment. Goodbye.",
        );
        setTimeout(() => void this.telnyx.hangup(ccid), 6000);
      }
      return;
    }

    if (turn.endCall) {
      // Long enough for the goodbye to finish playing. Telnyx stops speaking
      // the moment the relay ends, so ending it early cuts the caller off
      // mid-sentence.
      setTimeout(() => {
        this.end(ws, "done");
        void this.telnyx.hangup(ccid);
      }, 4000);
    }
  }

  private end(ws: WebSocket, reason: string): void {
    if (ws.readyState !== ws.OPEN) return;
    ws.send(JSON.stringify({ type: "end", handoffData: JSON.stringify({ reason }) }));
  }
}
