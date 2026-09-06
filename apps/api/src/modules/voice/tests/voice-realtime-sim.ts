import { EventEmitter } from "events";
import { VoiceRealtimeGateway } from "../voice-realtime.gateway";

// A whole speech-to-speech call, driven offline, through the real gateway.
//
// Every fault this engine has had was in the PROTOCOL, not the model: a
// greeting sent before the session was accepted, a keypress nobody handled,
// one tool call announced twice, a reply asked for while one was still being
// spoken, a dropped socket that left a caller in silence. Not one of them
// needed OpenAI to reproduce — and every one of them was found by somebody
// ringing the shop and reading a log afterwards, which is a slow and
// unpleasant way to learn that a field name changed.
//
// So both sockets are faked here and the gateway is real. The "model" is a
// script: it speaks when told to, and calls the tools a real model would call.
// What this CANNOT prove is whether gpt-realtime chooses the right tool — that
// is what a real call is for. What it can prove is that when it does, the
// order lands.

/** A socket that behaves enough like ws for the gateway. */
class FakeSocket extends EventEmitter {
  readyState = 1;
  readonly sent: any[] = [];
  send(raw: string): void {
    try {
      this.sent.push(JSON.parse(raw));
    } catch {
      this.sent.push(raw);
    }
  }
  /** Answered unless the test says the far end has stopped listening. */
  answersPing = true;
  ping(): void {
    if (this.answersPing) this.emit("pong");
  }
  close(): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.emit("close", 1000, Buffer.from(""));
  }
  /** Deliver a frame as if the other end had sent it. */
  deliver(frame: unknown): void {
    this.emit("message", Buffer.from(JSON.stringify(frame)));
  }
}

export interface RealtimeSimOptions {
  /** What the shop's tools should return, by tool name. */
  tools?: Record<string, { result: string; turn?: Record<string, unknown>; sayNow?: string }>;
  greeting?: string;
  /** How long a caller may wait before the line does something about it. */
  quietMs?: number;
  pingMs?: number;
  readyMs?: number;
  idleMs?: number;
}

export class VoiceRealtimeSim {
  readonly caller = new FakeSocket();
  readonly brain = new FakeSocket();
  readonly gateway: any;
  /** Every tool the gateway actually ran, in order. */
  readonly toolCalls: Array<{ name: string; input: any }> = [];
  readonly transfers: string[] = [];
  readonly log: string[] = [];
  private nextCallId = 1;

  constructor(private readonly opts: RealtimeSimOptions = {}) {
    const g: any = Object.create(VoiceRealtimeGateway.prototype);
    g.logger = {
      log: (m: string) => this.log.push(m),
      warn: (m: string) => this.log.push(`WARN ${m}`),
      error: (m: string) => this.log.push(`ERROR ${m}`),
    };
    g.seenEvents = new Set();
    g.calls = new Map();
    const env: Record<string, string> = {
      OPENAI_API_KEY: "test",
      VOICE_REALTIME_URL: "wss://api.example/voice/media",
      VOICE_RELAY_URL: "wss://api.example/voice/relay",
      VOICE_RELAY_SECRET: "shh",
      ...(opts.quietMs ? { VOICE_REALTIME_QUIET_MS: String(opts.quietMs) } : {}),
      ...(opts.pingMs ? { VOICE_REALTIME_PING_MS: String(opts.pingMs) } : {}),
      ...(opts.readyMs ? { VOICE_REALTIME_READY_MS: String(opts.readyMs) } : {}),
      ...(opts.idleMs ? { VOICE_REALTIME_IDLE_MS: String(opts.idleMs) } : {}),
    };
    g.config = { get: (k: string) => env[k] };
    g.connectToModel = () => this.brain;
    g.telnyx = {
      transfer: async (_ccid: string, to: string) => {
        this.transfers.push(to);
        return true;
      },
      hangup: async () => true,
      stopMediaStream: async () => true,
      startConversationRelay: async () => true,
    };
    g.voice = {
      realtimeSession: async () => ({
        instructions: "You are answering the telephone for Pizza Uno.",
        greeting: opts.greeting ?? "Hello and welcome to Pizza Uno. To place an order, press 1.",
        tools: [{ type: "function", name: "add_item", description: "", parameters: {} }],
      }),
      realtimeTool: async (_ccid: string, name: string, input: any) => {
        this.toolCalls.push({ name, input });
        return opts.tools?.[name] ?? { result: `${name} ok` };
      },
    };
    this.gateway = g;
  }

  /** Telnyx connects the media socket; the model session comes up. */
  async answer(ccid = "cc-test"): Promise<void> {
    // attach() only returns once both sockets have their listeners, so the
    // model's "open" cannot be announced before then — the same ordering the
    // real API has, where the socket cannot open before it is constructed.
    await this.gateway.attach(this.caller, ccid);
    this.brain.emit("open");
    await this.settle();
    this.brain.deliver({ type: "session.created" });
    this.brain.deliver({ type: "session.updated" });
    await this.settle();
  }

  /** The caller presses a key. Telnyx sends it down the media socket. */
  async press(digit: string): Promise<void> {
    this.caller.deliver({ event: "dtmf", stream_id: "s1", dtmf: { digit } });
    await this.settle();
  }

  /** The caller speaks; the model transcribes it. */
  async say(text: string): Promise<void> {
    this.brain.deliver({
      type: "conversation.item.input_audio_transcription.completed",
      transcript: text,
    });
    await this.settle();
  }

  /** The model speaks. */
  async speak(text: string): Promise<void> {
    this.brain.deliver({ type: "response.created" });
    this.brain.deliver({ type: "response.output_audio.delta", delta: "AAAA" });
    this.brain.deliver({ type: "response.output_audio_transcript.done", transcript: text });
    this.brain.deliver({ type: "response.done" });
    await this.settle();
  }

  /**
   * The model calls a tool — announced BOTH ways, as the GA API really does,
   * and while a response is still in flight, as it really is.
   */
  async callTool(name: string, input: Record<string, unknown> = {}): Promise<void> {
    const callId = `call_${this.nextCallId++}`;
    const args = JSON.stringify(input);
    this.brain.deliver({ type: "response.created" });
    this.brain.deliver({ type: "response.function_call_arguments.done", name, call_id: callId, arguments: args });
    await this.settle();
    this.brain.deliver({
      type: "response.output_item.done",
      item: { type: "function_call", name, call_id: callId, arguments: args },
    });
    await this.settle();
    this.brain.deliver({ type: "response.done" });
    await this.settle();
  }

  /** Audio frames the caller would hear. */
  get audioOut(): any[] {
    return this.caller.sent.filter((m) => m?.event === "media");
  }

  /** Everything the gateway told the model. */
  get toModel(): any[] {
    return this.brain.sent;
  }

  /** The session configuration the gateway sent. */
  get session(): any {
    return this.brain.sent.find((m) => m?.type === "session.update")?.session;
  }

  private async settle(): Promise<void> {
    for (let i = 0; i < 8; i++) await Promise.resolve();
    await new Promise((r) => setTimeout(r, 0));
  }
}
