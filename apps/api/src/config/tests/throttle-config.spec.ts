/**
 * Regression tests for the throttle config wiring.
 *
 * Context: app.module.ts reads `app.throttle.shortTtl/shortLimit/mediumTtl/
 * mediumLimit` to build the named throttlers, but app.config.ts historically
 * only defined the webhook/login keys — so those lookups always returned
 * undefined and the hardcoded fallbacks silently applied. The production
 * rate limits were NOT env-tunable, which mattered during the 2026-07 429
 * incident. These tests pin the contract: every key app.module.ts looks up
 * must exist in the config object, defaults must match the historical
 * fallbacks (behaviour unchanged), and env overrides must flow through.
 */
import { appConfig } from "../app.config";

describe("throttle config", () => {
  const ENV_KEYS = [
    "THROTTLE_SHORT_TTL",
    "THROTTLE_SHORT_LIMIT",
    "THROTTLE_MEDIUM_TTL",
    "THROTTLE_MEDIUM_LIMIT",
    "THROTTLE_WEBHOOK_TTL",
    "THROTTLE_WEBHOOK_LIMIT",
    "THROTTLE_LOGIN_TTL",
    "THROTTLE_LOGIN_LIMIT",
  ] as const;
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const k of ENV_KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  });

  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it("defaults match the historical hardcoded fallbacks (short 120/s, medium 4000/min)", () => {
    const cfg = appConfig();
    expect(cfg.throttle.shortTtl).toBe(1000);
    expect(cfg.throttle.shortLimit).toBe(120);
    expect(cfg.throttle.mediumTtl).toBe(60000);
    expect(cfg.throttle.mediumLimit).toBe(4000);
    expect(cfg.throttle.webhookTtl).toBe(60000);
    expect(cfg.throttle.webhookLimit).toBe(300);
    expect(cfg.throttle.loginTtl).toBe(60000);
    expect(cfg.throttle.loginLimit).toBe(10);
  });

  it("THROTTLE_SHORT_* / THROTTLE_MEDIUM_* env vars actually change the limits", () => {
    process.env.THROTTLE_SHORT_TTL = "2000";
    process.env.THROTTLE_SHORT_LIMIT = "250";
    process.env.THROTTLE_MEDIUM_TTL = "30000";
    process.env.THROTTLE_MEDIUM_LIMIT = "9000";
    const cfg = appConfig();
    expect(cfg.throttle.shortTtl).toBe(2000);
    expect(cfg.throttle.shortLimit).toBe(250);
    expect(cfg.throttle.mediumTtl).toBe(30000);
    expect(cfg.throttle.mediumLimit).toBe(9000);
  });

  it("exposes every key app.module.ts looks up (no more silent undefined)", () => {
    const cfg = appConfig() as { throttle: Record<string, number> };
    for (const key of [
      "shortTtl",
      "shortLimit",
      "mediumTtl",
      "mediumLimit",
      "webhookTtl",
      "webhookLimit",
      "loginTtl",
      "loginLimit",
    ]) {
      expect(cfg.throttle[key]).toEqual(expect.any(Number));
      expect(Number.isFinite(cfg.throttle[key])).toBe(true);
    }
  });
});
