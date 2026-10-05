import { CustomersController } from "../customers.controller";
import { screenPopPage, unsubstitutedMacro } from "../caller-id-screen-pop";

// The screen-pop route, for phone systems with no webhook at all.
//
// 8x8 Work — which is what a normal business phone licence buys — cannot post
// a webhook without a Contact Center or CPaaS licence. What every Work client
// CAN do is open a web address when a call arrives, substituting the caller's
// number into it. That is a GET, with the key in the query string, and a
// browser tab that opens on the shop's PC whether anyone wants it or not.

function controller(over: { auth?: any; customers?: any } = {}) {
  const setup = {
    authorise: jest.fn(async () => over.auth ?? { ok: true, locationExists: true, ownNumbers: [] }),
    record: jest.fn(),
  };
  const customers: any = {
    tenantForLocation: jest.fn(async () => "tenant-1"),
    lookupByPhone: jest.fn(async () => null),
    ...over.customers,
  };
  const socket: any = { emitToLocation: jest.fn() };
  return {
    c: new CustomersController(customers, socket, setup as any, { assertAccess: jest.fn() } as any),
    setup,
    socket,
    customers,
  };
}

describe("GET /customers/caller-id/voip/:locationId (desktop screen pop)", () => {
  it("rings the tills from a number in the QUERY, with the key in the query too", async () => {
    const { c, socket, setup } = controller();
    const html = await c.voipRingScreenPop("loc-1", {
      key: "ohcid_shopone",
      from: "+447940053972",
    });
    expect(setup.authorise).toHaveBeenCalledWith("loc-1", "ohcid_shopone");
    expect(socket.emitToLocation).toHaveBeenCalledWith(
      "loc-1",
      "callerid:ring",
      expect.objectContaining({ phone: "+447940053972" }),
    );
    expect(html).toContain("+447940053972");
    expect(html).toContain("Caller sent to the tills");
  });

  it("names a known customer on the page the desktop pops", async () => {
    const { c } = controller({
      customers: { lookupByPhone: async () => ({ name: "Omid", orders: 52 }) },
    });
    const html = await c.voipRingScreenPop("loc-1", { key: "k", from: "07940053972" });
    expect(html).toContain("Omid");
    expect(html).toContain("52 previous orders");
  });

  it("answers with a PAGE, never a JSON error — a person is looking at a tab", async () => {
    const { c } = controller({ auth: { ok: false, locationExists: true, ownNumbers: [] } });
    const html = await c.voipRingScreenPop("loc-1", { key: "wrong", from: "07940053972" });
    expect(html).toContain("<!doctype html>");
    expect(html).toContain("Not sent to the tills");
    // And it says the one thing they can act on.
    expect(html).toMatch(/key .* is wrong or missing/i);
  });

  it("still refuses a bad key — the page is friendly, the door is not", async () => {
    const { c, socket } = controller({ auth: { ok: false, locationExists: true, ownNumbers: [] } });
    await c.voipRingScreenPop("loc-1", { key: "wrong", from: "07940053972" });
    expect(socket.emitToLocation).not.toHaveBeenCalled();
  });

  it("records an unsubstituted macro by name — that IS the diagnosis", async () => {
    // The phone client opened the URL without filling the macro in: the URL is
    // in the wrong box, or that client spells the macro differently.
    const { c, setup } = controller();
    await c.voipRingScreenPop("loc-1", { key: "k", from: "%%CallerNumber%%" });
    expect(setup.record).toHaveBeenCalledWith(
      expect.objectContaining({ rejected: expect.stringContaining("%%CallerNumber%%") }),
    );
  });

  it("escapes what the phone system sent — the number is not ours", async () => {
    const { c } = controller();
    const html = await c.voipRingScreenPop("loc-1", {
      key: "k",
      from: "07940053972",
      caller: "<script>alert(1)</script>",
    });
    expect(html).not.toContain("<script>alert(1)</script>");
  });
});

describe("unsubstitutedMacro", () => {
  it("spots the macro styles a phone client might leave behind", () => {
    expect(unsubstitutedMacro({ from: "%%CallerNumber%%" })).toBe("%%CallerNumber%%");
    expect(unsubstitutedMacro({ from: "{{caller}}" })).toBe("{{caller}}");
    expect(unsubstitutedMacro({ from: "%CALLERID%" })).toBe("%CALLERID%");
  });

  it("says nothing about a real number", () => {
    expect(unsubstitutedMacro({ from: "+447940053972" })).toBeNull();
    expect(unsubstitutedMacro({})).toBeNull();
  });
});

describe("the page itself", () => {
  it("carries no external resources — it renders on a shop PC on a bad line", () => {
    const html = screenPopPage({ ok: true, phone: "+447940053972", match: null });
    expect(html).not.toMatch(/<script|src=|@import|https?:\/\//);
  });

  it("tells a new caller apart from a regular", () => {
    expect(screenPopPage({ ok: true, phone: "0790", match: null })).toContain(
      "New caller",
    );
    expect(
      screenPopPage({ ok: true, phone: "0790", match: { name: "Sam", orders: 1 } }),
    ).toContain("1 previous order");
  });
});
