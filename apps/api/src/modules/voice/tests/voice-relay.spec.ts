import { VoiceRelayGateway } from "../voice-relay.gateway";

// The relay's own logic, without a socket or a call.
//
// The wire protocol here is DOC-DERIVED, not yet proven against a real call —
// which is exactly why the gateway logs the first frame of each type verbatim
// and why the webhook transport is still the default. What can be tested
// without Telnyx is the part that decides who is allowed to talk to a caller.

const gw = (env: Record<string, string | undefined> = {}) => {
  const g = Object.create(VoiceRelayGateway.prototype) as any;
  g.logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn() };
  g.config = { get: (k: string) => env[k] };
  g.sockets = new Map();
  g.seenFrameTypes = new Set();
  return g;
};

describe("relayUrl", () => {
  it("is null when the relay is not configured, so webhooks stay in charge", () => {
    // The old transport is the default on purpose: a shop mid-service is not
    // where a new one should be proven.
    expect(gw().relayUrl("cc-1")).toBeNull();
  });

  it("carries a token derived from the call it is for", () => {
    const g = gw({ VOICE_RELAY_URL: "wss://api.example.com/voice/relay", VOICE_RELAY_SECRET: "s3cret" });
    const url = g.relayUrl("cc-abc");
    expect(url).toContain("wss://api.example.com/voice/relay?call=cc-abc&t=");
    expect(g.validToken("cc-abc", new URL(url).searchParams.get("t"))).toBe(true);
  });

  it("will not accept another call's token", () => {
    // The socket is a public endpoint that can speak to a caller. A token that
    // worked on any call would be a way in to all of them.
    const g = gw({ VOICE_RELAY_URL: "wss://x/voice/relay", VOICE_RELAY_SECRET: "s3cret" });
    const other = new URL(g.relayUrl("cc-other")).searchParams.get("t")!;
    expect(g.validToken("cc-abc", other)).toBe(false);
  });

  it("refuses an empty or malformed token without throwing", () => {
    const g = gw({ VOICE_RELAY_URL: "wss://x/voice/relay", VOICE_RELAY_SECRET: "s3cret" });
    expect(g.validToken("cc-abc", "")).toBe(false);
    expect(g.validToken("cc-abc", "short")).toBe(false);
    expect(g.validToken("cc-abc", undefined)).toBe(false);
  });

  it("does not double up the slash when the base URL has a trailing one", () => {
    const g = gw({ VOICE_RELAY_URL: "wss://x/voice/relay/", VOICE_RELAY_SECRET: "s" });
    expect(g.relayUrl("cc-1")).not.toContain("relay/?");
  });
});
