import { DeliverooAdapter } from "../../../webhooks/adapters/deliveroo.adapter";
import {
  confirmDueAt,
  isConfirmDue,
  isDeliverooConfirmed,
  needsDeliverooConfirm,
  readDeliverooSchedule,
  scheduleMetadata,
} from "../deliveroo-scheduled";

// A scheduled Deliveroo order is placed → accepted → CONFIRMED: a second
// status call, due by the `confirm_at` in their payload, meaning "the site is
// starting to prepare this". We never sent it, so every scheduled order sat
// at accepted. These pin when it is sent, and that it is sent only once.

describe("reading the schedule off a Deliveroo payload", () => {
  it("takes confirm_at and asap", () => {
    expect(
      readDeliverooSchedule({ asap: false, confirm_at: "2026-09-30T18:40:00Z" }),
    ).toEqual({ asap: false, confirmAt: new Date("2026-09-30T18:40:00Z") });
  });

  it("reads an ASAP order as having nothing to confirm", () => {
    expect(readDeliverooSchedule({ asap: true })).toEqual({ asap: true, confirmAt: null });
    expect(scheduleMetadata({ asap: true })).toEqual({ deliverooAsap: true });
  });

  it("ignores a confirm_at it can't parse rather than inventing a time", () => {
    expect(readDeliverooSchedule({ confirm_at: "soon" }).confirmAt).toBeNull();
    expect(readDeliverooSchedule({}).confirmAt).toBeNull();
  });

  it("stores the time as ISO on the order", () => {
    expect(scheduleMetadata({ asap: false, confirm_at: "2026-09-30T18:40:00Z" })).toEqual({
      deliverooAsap: false,
      deliverooConfirmAt: "2026-09-30T18:40:00.000Z",
    });
  });
});

describe("which orders need confirming", () => {
  const scheduled = { metadata: { deliverooConfirmAt: "2026-09-30T18:40:00Z" } };

  it("a scheduled order does", () => {
    expect(needsDeliverooConfirm(scheduled)).toBe(true);
    // asap:false alone is enough — an order whose confirm_at we never saw is
    // still confirmed when the kitchen starts it, rather than never.
    expect(needsDeliverooConfirm({ metadata: { deliverooAsap: false } })).toBe(true);
    expect(needsDeliverooConfirm({ metadata: {}, scheduledFor: new Date() })).toBe(true);
  });

  it("an ASAP order does not", () => {
    expect(needsDeliverooConfirm({ metadata: { deliverooAsap: true } })).toBe(false);
    expect(needsDeliverooConfirm({ metadata: {} })).toBe(false);
    expect(needsDeliverooConfirm({})).toBe(false);
  });

  it("one already confirmed never is again", () => {
    expect(
      needsDeliverooConfirm({
        metadata: { ...scheduled.metadata, deliverooConfirmedAt: "2026-09-30T18:41:00Z" },
      }),
    ).toBe(false);
    expect(isDeliverooConfirmed({ deliverooConfirmedAt: "2026-09-30T18:41:00Z" })).toBe(true);
  });
});

describe("when the sweep confirms one nobody has started", () => {
  const meta = { deliverooConfirmAt: "2026-09-30T18:40:00Z" };

  it("waits for Deliveroo's confirm_at — never early", () => {
    // Taken at noon for 7pm: confirming at 12:05 would tell them the kitchen
    // has started, seven hours out.
    expect(isConfirmDue(meta, new Date("2026-09-30T12:05:00Z"))).toBe(false);
    expect(isConfirmDue(meta, new Date("2026-09-30T18:39:59Z"))).toBe(false);
  });

  it("fires from confirm_at onwards", () => {
    expect(isConfirmDue(meta, new Date("2026-09-30T18:40:00Z"))).toBe(true);
    expect(isConfirmDue(meta, new Date("2026-09-30T18:55:00Z"))).toBe(true);
  });

  it("has nothing to sweep without a confirm_at", () => {
    expect(confirmDueAt({ deliverooAsap: false })).toBeNull();
    expect(isConfirmDue({ deliverooAsap: false }, new Date())).toBe(false);
  });
});

describe("the adapter keeps the schedule on the order", () => {
  const adapter = new DeliverooAdapter();
  const payload = (order: Record<string, unknown>) => ({
    order: {
      id: "o1",
      status: "placed",
      items: [],
      customer: {},
      fulfillment_type: "deliveroo",
      ...order,
    },
  });

  it("carries confirm_at through to metadata", () => {
    const c = adapter.normalize(
      payload({ asap: false, confirm_at: "2026-09-30T18:40:00Z" }),
      "loc-1",
    )!;
    expect(c.metadata).toMatchObject({
      deliverooAsap: false,
      deliverooConfirmAt: "2026-09-30T18:40:00.000Z",
    });
    expect(needsDeliverooConfirm({ metadata: c.metadata })).toBe(true);
  });

  it("leaves an ASAP order with nothing to confirm", () => {
    const c = adapter.normalize(payload({ asap: true }), "loc-1")!;
    expect(needsDeliverooConfirm({ metadata: c.metadata })).toBe(false);
  });
});
