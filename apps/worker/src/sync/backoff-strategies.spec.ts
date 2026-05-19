import { rateLimitAwareBackoff } from "./backoff-strategies";

const MAX_BACKOFF_MS = 60_000;
const EXPONENTIAL_BASE_MS = 3_000;

describe("rateLimitAwareBackoff", () => {
  describe("RATE_LIMITED error", () => {
    it("returns the exact ms encoded in the error message", () => {
      const err = new Error("RATE_LIMITED:12000");
      expect(rateLimitAwareBackoff(1, err)).toBe(12000);
    });

    it("returns retryAfterMs of 1ms (minimum parseable value)", () => {
      const err = new Error("RATE_LIMITED:1");
      expect(rateLimitAwareBackoff(1, err)).toBe(1);
    });

    it("caps at MAX_BACKOFF_MS when provider sends a very long Retry-After", () => {
      const err = new Error("RATE_LIMITED:999999");
      expect(rateLimitAwareBackoff(1, err)).toBe(MAX_BACKOFF_MS);
    });

    it("falls back to exponential when retryAfterMs is 0 (no Retry-After header)", () => {
      const err = new Error("RATE_LIMITED:0");
      // attempt 1 → (2^1 - 1) * 3000 = 3000
      expect(rateLimitAwareBackoff(1, err)).toBe(3_000);
    });

    it("falls back to exponential when retryAfterMs is NaN", () => {
      const err = new Error("RATE_LIMITED:abc");
      expect(rateLimitAwareBackoff(1, err)).toBe(3_000);
    });
  });

  describe("non-rate-limit errors use exponential backoff", () => {
    it("returns exponential delay for attempt 1", () => {
      const err = new Error("Network error");
      // (2^1 - 1) * 3000 = 3000
      expect(rateLimitAwareBackoff(1, err)).toBe(3_000);
    });

    it("returns exponential delay for attempt 2", () => {
      const err = new Error("Sync failed");
      // (2^2 - 1) * 3000 = 9000
      expect(rateLimitAwareBackoff(2, err)).toBe(9_000);
    });

    it("returns exponential delay for attempt 3", () => {
      const err = new Error("Sync failed");
      // (2^3 - 1) * 3000 = 21000
      expect(rateLimitAwareBackoff(3, err)).toBe(21_000);
    });

    it("caps exponential at MAX_BACKOFF_MS for high attempt counts", () => {
      const err = new Error("Sync failed");
      expect(rateLimitAwareBackoff(10, err)).toBe(MAX_BACKOFF_MS);
    });

    it("handles null error gracefully", () => {
      // Bull may call with null in some edge cases
      expect(rateLimitAwareBackoff(1, null as unknown as Error)).toBe(3_000);
    });

    it("handles error with no message", () => {
      expect(rateLimitAwareBackoff(1, new Error())).toBe(3_000);
    });
  });
});
