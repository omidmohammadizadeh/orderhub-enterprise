import { UberEatsStoreControlAdapter } from "../../ubereats/ubereats-store-control.adapter";
import { DeliverooStoreControlAdapter } from "../../deliveroo/deliveroo-store-control.adapter";
import { JetStoreControlAdapter } from "../../jet/jet-store-control.adapter";
import { StoreStatusUnavailableError } from "../store-control";

// Each adapter is delegation only: the platform services keep their own
// live-verified rules. What these pin is the TRANSLATION — the three
// platforms disagree about the pause-end time and about the words they use
// for trading, and getting that wrong pauses a shop that should be open.

describe("Uber Eats adapter", () => {
  const calls: any[] = [];
  const connections = {
    setStoreOnline: (...args: any[]) => {
      calls.push(args);
      return Promise.resolve({ status: args[2] ? "ONLINE" : "OFFLINE" });
    },
    storeStatus: () =>
      Promise.resolve({
        status: "OFFLINE",
        offlineUntil: "2026-10-09T18:00:00Z",
        offlineReason: "PAUSED_BY_RESTAURANT",
      }),
  };
  const adapter = new UberEatsStoreControlAdapter(connections as any);

  beforeEach(() => (calls.length = 0));

  it("passes the pause reason and end time into Uber's positional slots", async () => {
    const until = new Date("2026-10-09T18:00:00Z");
    const res = await adapter.setStoreOpen("t1", "c1", false, {
      until,
      reason: "KITCHEN_CLOSED",
    });
    expect(calls[0]).toEqual(["t1", "c1", false, "KITCHEN_CLOSED", until]);
    expect(res).toEqual({ state: "CLOSED", raw: "OFFLINE" });
  });

  it("sends null rather than undefined when there is no end time", async () => {
    // The +24h default is the service's own rule — the adapter must not
    // invent a second one, or the two drift apart.
    await adapter.setStoreOpen("t1", "c1", true);
    expect(calls[0]).toEqual(["t1", "c1", true, undefined, null]);
  });

  it("reads ONLINE/OFFLINE back as OPEN/CLOSED and keeps Uber's own word", async () => {
    expect(await adapter.storeStatus("t1", "c1")).toEqual({
      state: "CLOSED",
      raw: "OFFLINE",
      until: "2026-10-09T18:00:00Z",
      reason: "PAUSED_BY_RESTAURANT",
    });
  });
});

describe("Deliveroo adapter", () => {
  const calls: any[] = [];
  const connections = {
    setStoreOpen: (...args: any[]) => {
      calls.push(args);
      return Promise.resolve({ status: args[2] ? "OPEN" : "CLOSED" });
    },
    storeStatus: () => Promise.resolve({ status: "OPEN" }),
  };
  const adapter = new DeliverooStoreControlAdapter(connections as any);

  beforeEach(() => (calls.length = 0));

  it("does not pass an end time Deliveroo has no field for", async () => {
    await adapter.setStoreOpen("t1", "c1", false, {
      until: new Date("2026-10-09T18:00:00Z"),
    });
    expect(calls[0]).toEqual(["t1", "c1", false]);
  });

  it("reports a closed site with no reopen time", async () => {
    // A Deliveroo site stays closed until something opens it, so promising
    // a reopen time here would be a lie the UI would then display.
    expect(await adapter.storeStatus("t1", "c1")).toEqual({
      state: "OPEN",
      raw: "OPEN",
      until: null,
      reason: null,
    });
  });
});

describe("Just Eat adapter", () => {
  const calls: any[] = [];
  const status = {
    setStoreOnline: (...args: any[]) => {
      calls.push(args);
      return Promise.resolve({ ok: true, online: args[2], restaurant: "r1" });
    },
  };
  const adapter = new JetStoreControlAdapter(status as any);

  beforeEach(() => (calls.length = 0));

  it("maps the pause end onto JET's onlineAt", async () => {
    const until = new Date("2026-10-09T18:00:00Z");
    const res = await adapter.setStoreOpen("t1", "c1", false, { until });
    expect(calls[0]).toEqual(["t1", "c1", false, { onlineAt: until }]);
    expect(res).toEqual({ state: "CLOSED", raw: "OFFLINE" });
  });

  it("sends null for an indefinite pause, which JET's service logs loudly", async () => {
    await adapter.setStoreOpen("t1", "c1", false);
    expect(calls[0]).toEqual(["t1", "c1", false, { onlineAt: null }]);
  });

  it("refuses to report a trading state JET never told us", async () => {
    // JET's own "store-status" route is inbound — them telling us a
    // restaurant went offline. There is nothing to read back.
    expect(adapter.canReadStatus).toBe(false);
    await expect(adapter.storeStatus("t1", "c1")).rejects.toBeInstanceOf(
      StoreStatusUnavailableError,
    );
  });
});
