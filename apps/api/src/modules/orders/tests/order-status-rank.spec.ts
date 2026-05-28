import {
  STATUS_RANK,
  TERMINAL_STATUSES,
  CANCELLABLE_STATUSES,
  getRank,
  isTerminal,
  isCancellation,
  isMonotonicForward,
  assertMonotonicOrCancel,
} from "@orderhub/shared";

describe("STATUS_RANK", () => {
  it("ranks happy-path stages strictly ascending", () => {
    expect(STATUS_RANK.PENDING).toBeLessThan(STATUS_RANK.ACCEPTED);
    expect(STATUS_RANK.ACCEPTED).toBeLessThan(STATUS_RANK.PREPARING);
    expect(STATUS_RANK.PREPARING).toBeLessThan(STATUS_RANK.READY);
    expect(STATUS_RANK.READY).toBeLessThan(STATUS_RANK.ASSIGNED_DRIVER);
    expect(STATUS_RANK.ASSIGNED_DRIVER).toBeLessThan(
      STATUS_RANK.ACCEPTED_BY_DRIVER,
    );
    expect(STATUS_RANK.ACCEPTED_BY_DRIVER).toBeLessThan(
      STATUS_RANK.OUT_FOR_DELIVERY,
    );
    expect(STATUS_RANK.OUT_FOR_DELIVERY).toBeLessThan(STATUS_RANK.COMPLETED);
  });

  it("treats DISPATCHED as legacy alias of OUT_FOR_DELIVERY", () => {
    expect(STATUS_RANK.DISPATCHED).toBe(STATUS_RANK.OUT_FOR_DELIVERY);
  });

  it("ranks all terminal exception states at top so they absorb in-flight", () => {
    for (const s of ["CANCELLED", "REJECTED", "FAILED"] as const) {
      expect(STATUS_RANK[s]).toBeGreaterThanOrEqual(STATUS_RANK.OUT_FOR_DELIVERY);
    }
  });
});

describe("getRank / isTerminal / isCancellation", () => {
  it("getRank delegates to the table", () => {
    expect(getRank("PENDING")).toBe(STATUS_RANK.PENDING);
    expect(getRank("COMPLETED")).toBe(STATUS_RANK.COMPLETED);
  });

  it("isTerminal flags COMPLETED + cancellation flavours", () => {
    for (const s of TERMINAL_STATUSES) expect(isTerminal(s)).toBe(true);
    expect(isTerminal("PENDING")).toBe(false);
    expect(isTerminal("OUT_FOR_DELIVERY")).toBe(false);
  });

  it("isCancellation is true for CANCELLED / REJECTED / FAILED only", () => {
    expect(isCancellation("CANCELLED")).toBe(true);
    expect(isCancellation("REJECTED")).toBe(true);
    expect(isCancellation("FAILED")).toBe(true);
    expect(isCancellation("COMPLETED")).toBe(false);
    expect(isCancellation("READY")).toBe(false);
  });

  it("CANCELLABLE_STATUSES excludes terminal states", () => {
    for (const s of CANCELLABLE_STATUSES) expect(isTerminal(s)).toBe(false);
  });
});

describe("isMonotonicForward", () => {
  it("true for any strict forward move on the happy path", () => {
    expect(isMonotonicForward("PENDING", "ACCEPTED")).toBe(true);
    expect(isMonotonicForward("READY", "OUT_FOR_DELIVERY")).toBe(true);
    expect(isMonotonicForward("OUT_FOR_DELIVERY", "COMPLETED")).toBe(true);
  });

  it("false for same status (no-op)", () => {
    expect(isMonotonicForward("ACCEPTED", "ACCEPTED")).toBe(false);
  });

  it("false for backwards movement", () => {
    expect(isMonotonicForward("READY", "PREPARING")).toBe(false);
    expect(isMonotonicForward("OUT_FOR_DELIVERY", "ASSIGNED_DRIVER")).toBe(false);
  });

  it("false for cancellation (handled separately at call sites)", () => {
    expect(isMonotonicForward("READY", "CANCELLED")).toBe(false);
    expect(isMonotonicForward("PENDING", "REJECTED")).toBe(false);
    expect(isMonotonicForward("PREPARING", "FAILED")).toBe(false);
  });
});

describe("assertMonotonicOrCancel — Base44 parity backstop", () => {
  it("always permits cancellation regardless of rank", () => {
    expect(() => assertMonotonicOrCancel("READY", "CANCELLED")).not.toThrow();
    expect(() => assertMonotonicOrCancel("PENDING", "REJECTED")).not.toThrow();
    expect(() => assertMonotonicOrCancel("OUT_FOR_DELIVERY", "FAILED")).not.toThrow();
  });

  it("permits strict forward movement", () => {
    expect(() => assertMonotonicOrCancel("PENDING", "ACCEPTED")).not.toThrow();
    expect(() => assertMonotonicOrCancel("READY", "ASSIGNED_DRIVER")).not.toThrow();
  });

  it("rejects status downgrade", () => {
    expect(() =>
      assertMonotonicOrCancel("OUT_FOR_DELIVERY", "ASSIGNED_DRIVER"),
    ).toThrow(/downgrade rejected/i);
    expect(() => assertMonotonicOrCancel("READY", "PREPARING")).toThrow(
      /downgrade rejected/i,
    );
  });

  it("rejects transitions out of any terminal state", () => {
    for (const t of TERMINAL_STATUSES) {
      expect(() => assertMonotonicOrCancel(t, "PENDING")).toThrow(
        /terminal state/i,
      );
    }
  });
});
