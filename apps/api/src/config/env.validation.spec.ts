import * as crypto from "crypto";
import { validateEnv } from "./env.validation";

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeValidKey(): string {
  return crypto.randomBytes(32).toString("hex");
}

function makeValidBase(): Record<string, unknown> {
  return {
    NODE_ENV: "development",
    DATABASE_URL: "postgresql://user:pass@localhost:5432/orderhub",
    REDIS_URL: "redis://localhost:6379",
    QUEUE_REDIS_URL: "redis://localhost:6379",
    JWT_SECRET: crypto.randomBytes(32).toString("hex"),
    JWT_REFRESH_SECRET: crypto.randomBytes(32).toString("hex"),
    CREDENTIAL_ENCRYPTION_KEY: makeValidKey(),
  };
}

function makeValidProduction(): Record<string, unknown> {
  return {
    ...makeValidBase(),
    NODE_ENV: "production",
    APP_URL: "https://app.orderhub.io",
    API_URL: "https://api.orderhub.io",
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

let exitSpy: jest.SpyInstance;

beforeEach(() => {
  exitSpy = jest.spyOn(process, "exit").mockImplementation((() => {}) as any);
  jest.spyOn(console, "error").mockImplementation(() => {});
  jest.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  exitSpy.mockRestore();
  jest.restoreAllMocks();
});

describe("validateEnv", () => {
  // ── Required fields ─────────────────────────────────────────────────────

  it("accepts a valid development config", () => {
    const result = validateEnv(makeValidBase());
    expect(result.NODE_ENV).toBe("development");
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it("exits when DATABASE_URL is missing", () => {
    const env = makeValidBase();
    delete env.DATABASE_URL;
    validateEnv(env);
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("exits when JWT_SECRET is too short", () => {
    const env = makeValidBase();
    env.JWT_SECRET = "tooshort";
    validateEnv(env);
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("exits when CREDENTIAL_ENCRYPTION_KEY is wrong length", () => {
    const env = makeValidBase();
    env.CREDENTIAL_ENCRYPTION_KEY = "deadbeef"; // 8 hex chars, not 64
    validateEnv(env);
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("exits when CREDENTIAL_ENCRYPTION_KEY has non-hex chars", () => {
    const env = makeValidBase();
    env.CREDENTIAL_ENCRYPTION_KEY = "z".repeat(64); // not hex
    validateEnv(env);
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  // ── Production-specific safety checks ───────────────────────────────────

  it("accepts a valid production config", () => {
    const result = validateEnv(makeValidProduction());
    expect(result.NODE_ENV).toBe("production");
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it("exits in production when no encryption key is set", () => {
    const env = makeValidProduction();
    delete env.CREDENTIAL_ENCRYPTION_KEY;
    delete env.CREDENTIAL_ENCRYPTION_KEY_CURRENT;
    delete env.ENCRYPTION_KEY;
    validateEnv(env);
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("exits in production when JWT_SECRET contains 'change-me'", () => {
    const env = makeValidProduction();
    env.JWT_SECRET = "change-me-please-do-not-use-in-prod-123";
    validateEnv(env);
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("exits in production when JWT_SECRET contains 'secret'", () => {
    const env = makeValidProduction();
    env.JWT_SECRET = "super-secret-key-that-is-32-chars-long!!";
    validateEnv(env);
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("exits in production when APP_URL is localhost", () => {
    const env = makeValidProduction();
    env.APP_URL = "http://localhost:3000";
    validateEnv(env);
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("accepts CREDENTIAL_ENCRYPTION_KEY_CURRENT in production instead of legacy key", () => {
    const env = makeValidProduction();
    delete env.CREDENTIAL_ENCRYPTION_KEY;
    env.CREDENTIAL_ENCRYPTION_KEY_CURRENT = makeValidKey();
    const result = validateEnv(env);
    expect(result.CREDENTIAL_ENCRYPTION_KEY_CURRENT).toBeDefined();
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it("exits in production when CREDENTIAL_ENCRYPTION_KEY is all zeros", () => {
    const env = makeValidProduction();
    env.CREDENTIAL_ENCRYPTION_KEY = "0".repeat(64);
    validateEnv(env);
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("does not exit in development when no encryption key is set", () => {
    const env = makeValidBase();
    delete env.CREDENTIAL_ENCRYPTION_KEY;
    env.NODE_ENV = "development";
    const result = validateEnv(env);
    expect(result.NODE_ENV).toBe("development");
    expect(exitSpy).not.toHaveBeenCalled();
  });

  // ── Optional fields have sensible defaults ───────────────────────────────

  it("sets default CREDENTIAL_ENCRYPTION_KEY_ID to v1", () => {
    const result = validateEnv(makeValidBase());
    expect(result.CREDENTIAL_ENCRYPTION_KEY_ID).toBe("v1");
  });

  it("sets default OUTBOX_PROCESSING_TIMEOUT_SECONDS to 300", () => {
    const result = validateEnv(makeValidBase());
    expect(result.OUTBOX_PROCESSING_TIMEOUT_SECONDS).toBe(300);
  });

  it("accepts a custom OUTBOX_PROCESSING_TIMEOUT_SECONDS", () => {
    const env = makeValidBase();
    env.OUTBOX_PROCESSING_TIMEOUT_SECONDS = "600";
    const result = validateEnv(env);
    expect(result.OUTBOX_PROCESSING_TIMEOUT_SECONDS).toBe(600);
  });
});
