import { BadRequestException } from "@nestjs/common";
import {
  canTransition,
  assertTransition,
  getTimestampField,
} from "../order-state-machine";

describe("Order State Machine", () => {
  describe("canTransition", () => {
    it("allows valid forward transitions", () => {
      expect(canTransition("PENDING", "ACCEPTED")).toBe(true);
      expect(canTransition("PENDING", "REJECTED")).toBe(true);
      expect(canTransition("PENDING", "CANCELLED")).toBe(true);
      expect(canTransition("ACCEPTED", "PREPARING")).toBe(true);
      expect(canTransition("ACCEPTED", "CANCELLED")).toBe(true);
      expect(canTransition("PREPARING", "READY")).toBe(true);
      expect(canTransition("READY", "DISPATCHED")).toBe(true);
      expect(canTransition("READY", "COMPLETED")).toBe(true);
      expect(canTransition("DISPATCHED", "COMPLETED")).toBe(true);
    });

    it("rejects backwards transitions", () => {
      expect(canTransition("ACCEPTED", "PENDING")).toBe(false);
      expect(canTransition("PREPARING", "ACCEPTED")).toBe(false);
      expect(canTransition("READY", "PREPARING")).toBe(false);
      expect(canTransition("COMPLETED", "READY")).toBe(false);
    });

    it("rejects same-status transitions", () => {
      expect(canTransition("PENDING", "PENDING")).toBe(false);
      expect(canTransition("ACCEPTED", "ACCEPTED")).toBe(false);
    });

    it("rejects transitions from terminal states", () => {
      expect(canTransition("COMPLETED", "CANCELLED")).toBe(false);
      expect(canTransition("CANCELLED", "PENDING")).toBe(false);
      expect(canTransition("REJECTED", "ACCEPTED")).toBe(false);
    });

    it("rejects impossible direct jumps", () => {
      expect(canTransition("PENDING", "COMPLETED")).toBe(false);
      expect(canTransition("PENDING", "DISPATCHED")).toBe(false);
      expect(canTransition("ACCEPTED", "DISPATCHED")).toBe(false);
    });
  });

  describe("assertTransition", () => {
    it("passes for valid transitions", () => {
      expect(() => assertTransition("PENDING", "ACCEPTED")).not.toThrow();
      expect(() => assertTransition("ACCEPTED", "PREPARING")).not.toThrow();
      expect(() => assertTransition("PREPARING", "READY")).not.toThrow();
      expect(() => assertTransition("READY", "DISPATCHED")).not.toThrow();
      expect(() => assertTransition("DISPATCHED", "COMPLETED")).not.toThrow();
    });

    it("throws BadRequestException for terminal state mutation", () => {
      expect(() => assertTransition("COMPLETED", "CANCELLED")).toThrow(BadRequestException);
      expect(() => assertTransition("CANCELLED", "ACCEPTED")).toThrow(BadRequestException);
      expect(() => assertTransition("REJECTED", "PENDING")).toThrow(BadRequestException);
    });

    it("includes the current status in terminal state error message", () => {
      try {
        assertTransition("COMPLETED", "CANCELLED");
        fail("should have thrown");
      } catch (e: any) {
        expect(e.message).toContain("COMPLETED");
        expect(e.message).toContain("terminal");
      }
    });

    it("throws BadRequestException for invalid non-terminal transitions", () => {
      expect(() => assertTransition("PENDING", "COMPLETED")).toThrow(BadRequestException);
      expect(() => assertTransition("ACCEPTED", "PENDING")).toThrow(BadRequestException);
    });

    it("error message lists allowed transitions", () => {
      try {
        assertTransition("PENDING", "COMPLETED");
        fail("should have thrown");
      } catch (e: any) {
        expect(e.message).toContain("PENDING");
        expect(e.message).toContain("COMPLETED");
        // Should list what IS allowed
        expect(e.message).toMatch(/ACCEPTED|REJECTED|CANCELLED/);
      }
    });

    it("cancellation is allowed from most non-terminal states", () => {
      const cancellableStates = ["PENDING", "ACCEPTED", "PREPARING", "READY", "DISPATCHED"] as const;
      for (const state of cancellableStates) {
        expect(() => assertTransition(state, "CANCELLED")).not.toThrow();
      }
    });
  });

  describe("getTimestampField", () => {
    it("maps status transitions to timestamp field names", () => {
      expect(getTimestampField("ACCEPTED")).toBe("acceptedAt");
      expect(getTimestampField("PREPARING")).toBe("preparingAt");
      expect(getTimestampField("READY")).toBe("readyAt");
      expect(getTimestampField("DISPATCHED")).toBe("outForDeliveryAt");
      expect(getTimestampField("OUT_FOR_DELIVERY")).toBe("outForDeliveryAt");
      expect(getTimestampField("COMPLETED")).toBe("deliveredAt");
      expect(getTimestampField("CANCELLED")).toBe("cancelledAt");
    });

    it("returns null for statuses without dedicated timestamps", () => {
      expect(getTimestampField("PENDING")).toBeNull();
      expect(getTimestampField("REJECTED")).toBeNull();
      // Driver-handoff timestamps live on DriverAssignment, not Order.
      expect(getTimestampField("ASSIGNED_DRIVER")).toBeNull();
      expect(getTimestampField("ACCEPTED_BY_DRIVER")).toBeNull();
      expect(getTimestampField("FAILED")).toBeNull();
    });
  });

  // ── Phase AJ — driver-handoff states + FAILED ──────────────────────────────
  describe("Phase AJ — driver-handoff lifecycle", () => {
    it("allows READY → ASSIGNED_DRIVER → ACCEPTED_BY_DRIVER → OUT_FOR_DELIVERY → COMPLETED", () => {
      expect(canTransition("READY", "ASSIGNED_DRIVER")).toBe(true);
      expect(canTransition("ASSIGNED_DRIVER", "ACCEPTED_BY_DRIVER")).toBe(true);
      expect(canTransition("ACCEPTED_BY_DRIVER", "OUT_FOR_DELIVERY")).toBe(true);
      expect(canTransition("OUT_FOR_DELIVERY", "COMPLETED")).toBe(true);
    });

    it("allows shortcuts that skip driver-accept", () => {
      // Some platforms (Deliveroo) don't surface the driver-accept event.
      expect(canTransition("ASSIGNED_DRIVER", "OUT_FOR_DELIVERY")).toBe(true);
      // Legacy direct dispatch path: READY → DISPATCHED → COMPLETED.
      expect(canTransition("READY", "DISPATCHED")).toBe(true);
      expect(canTransition("READY", "OUT_FOR_DELIVERY")).toBe(true);
    });

    it("allows FAILED from any non-terminal state", () => {
      const nonTerminal = [
        "PENDING",
        "ACCEPTED",
        "PREPARING",
        "READY",
        "ASSIGNED_DRIVER",
        "ACCEPTED_BY_DRIVER",
        "OUT_FOR_DELIVERY",
        "DISPATCHED",
      ] as const;
      for (const s of nonTerminal) {
        expect(canTransition(s, "FAILED")).toBe(true);
      }
    });

    it("blocks transitions out of FAILED", () => {
      expect(canTransition("FAILED", "ACCEPTED")).toBe(false);
      expect(canTransition("FAILED", "COMPLETED")).toBe(false);
      expect(() => assertTransition("FAILED", "PENDING")).toThrow(
        BadRequestException,
      );
    });

    it("blocks driver-state regression (rank guard)", () => {
      // OUT_FOR_DELIVERY → ASSIGNED_DRIVER would be a downgrade; the rank
      // guard in the shared package catches this before the whitelist.
      expect(() =>
        assertTransition("OUT_FOR_DELIVERY", "ASSIGNED_DRIVER"),
      ).toThrow(BadRequestException);
    });
  });
});
