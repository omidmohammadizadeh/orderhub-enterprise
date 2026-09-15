import {
  simultaneousRingProviderMessage,
  webhookProviderMessage,
} from "@orderhub/shared";

// This is product copy, and it is tested anyway.
//
// Every rule below is in the message because leaving it out has already cost
// an operator a phone call with a provider — and each one would be deleted by
// a well-meaning copy edit without anybody noticing until a till started
// popping up callers who had hung up ten minutes earlier.

describe("what we tell a provider to send (webhook route)", () => {
  const msg = webhookProviderMessage(
    "https://api.example.com/api/v1/customers/caller-id/voip/loc-1",
    "ohcid_abc",
  );

  it("carries the shop's own address and key", () => {
    expect(msg).toContain("/api/v1/customers/caller-id/voip/loc-1");
    expect(msg).toContain("x-voip-key: ohcid_abc");
  });

  it("asks for the RINGING event only — phantom popups were a real bug", () => {
    expect(msg).toMatch(/INCOMING \/ RINGING event ONLY/);
    for (const event of ["answered", "ended", "missed", "voicemail"]) {
      expect(msg).toContain(event);
    }
    expect(msg).toMatch(/not answered, ended, missed or voicemail/);
  });

  it("asks for the CALLER's number, not the shop's own", () => {
    expect(msg).toMatch(/CALLER's number, not our own number/);
  });

  it("puts the key in a header, because web addresses end up in logs", () => {
    expect(msg).toMatch(/header rather than in the web address/);
    // And never suggests the ?key= form, which the endpoint still accepts for
    // providers that cannot send headers but which we must not recommend.
    expect(msg).not.toContain("?key=");
  });

  it("says what to do when the shop has no key yet, rather than printing 'null'", () => {
    const noKey = webhookProviderMessage("https://api.example.com/x", null);
    expect(noKey).not.toContain("null");
    expect(noKey).toContain("<ask the shop for its key>");
  });
});

describe("what we tell a provider to do (simultaneous-ring route)", () => {
  const msg = simultaneousRingProviderMessage("+441632960999");

  it("names the number they have to ring", () => {
    expect(msg).toContain("+441632960999");
  });

  it("asks the two questions that decide whether the route works at all", () => {
    // (a) a second, OUTSIDE number, ringing at the SAME time — a divert that
    // fires after the line rings out is too late.
    expect(msg).toMatch(/second, OUTSIDE number at the same time/);
    expect(msg).toMatch(/after our line has rung out is too late/);
    // (b) whose number arrives.
    expect(msg).toMatch(/CALLER's number be passed to that second number/);
    expect(msg).toMatch(/pass the original caller ID through/);
  });

  it("says the line never answers, so nobody fears losing a call or being billed", () => {
    expect(msg).toMatch(/never answers/);
    expect(msg).toMatch(/nobody is charged for it/);
  });

  it("leaves a placeholder rather than an empty line when no number is assigned", () => {
    const none = simultaneousRingProviderMessage(null);
    expect(none).toContain("<the number we've assigned this shop>");
    expect(simultaneousRingProviderMessage("   ")).toContain("<the number we've assigned this shop>");
  });
});
