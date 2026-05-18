// Global test environment setup.
// This file runs once before all test suites.

process.env.NODE_ENV = "test";

// Provide minimal env vars to pass Zod validation during tests.
// Tests that need real DB/Redis should use their own env setup.
process.env.JWT_SECRET = "test-jwt-secret-that-is-at-least-32-characters-long";
process.env.JWT_REFRESH_SECRET = "test-jwt-refresh-secret-that-is-at-least-32-char";
process.env.ENCRYPTION_KEY = "0000000000000000000000000000000000000000000000000000000000000001";
process.env.DATABASE_URL = process.env.DATABASE_URL ?? "postgresql://orderhub_test:orderhub_test_secret@localhost:5432/orderhub_test";
process.env.REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6379";
process.env.QUEUE_REDIS_URL = process.env.QUEUE_REDIS_URL ?? "redis://localhost:6379";

// Silence console output in tests unless VERBOSE_TESTS=1 is set
if (!process.env.VERBOSE_TESTS) {
  jest.spyOn(console, "log").mockImplementation(() => {});
  jest.spyOn(console, "info").mockImplementation(() => {});
  jest.spyOn(console, "debug").mockImplementation(() => {});
}
