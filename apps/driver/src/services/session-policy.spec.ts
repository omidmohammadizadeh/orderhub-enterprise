import {
  canRetryRefresh,
  isSessionDead,
  refreshBackoffMs,
} from "./session-policy";

// Drivers were being logged out mid-shift.
//
// The app cleared the session whenever a token refresh failed, for any reason.
// A refresh happens every time the 15-minute access token expires, and a
// driver's phone fails requests constantly — tunnels, carrier handovers, the
// API restarting on a deploy, the refresh endpoint's own 30/min rate limit. Any
// one of those threw them back to the login screen, job card gone, at a
// doorstep, where a password cannot be typed one-handed.
//
// The line these tests hold: only the auth server saying "this token is dead"
// ends a session. Not being able to ask does not.

const axiosError = (status: number) => ({
  message: `Request failed with status code ${status}`,
  response: { status },
});

describe("isSessionDead", () => {
  it.each([401, 403])("is true when the auth server rejects the token (%i)", (s) => {
    expect(isSessionDead(axiosError(s))).toBe(true);
  });

  it.each([
    ["no signal / DNS / TLS — no response at all", new Error("Network Error")],
    ["request timed out", Object.assign(new Error("timeout of 20000ms exceeded"), { code: "ECONNABORTED" })],
    ["rate limited", axiosError(429)],
    ["API restarting mid-deploy", axiosError(502)],
    ["API error", axiosError(500)],
    ["gateway timeout", axiosError(504)],
  ])("keeps the driver signed in: %s", (_why, err) => {
    expect(isSessionDead(err)).toBe(false);
  });

  it("does not sign out on something unrecognisable", () => {
    expect(isSessionDead(undefined)).toBe(false);
    expect(isSessionDead(null)).toBe(false);
    expect(isSessionDead({})).toBe(false);
    expect(isSessionDead("boom")).toBe(false);
  });
});

describe("backoff between refresh attempts", () => {
  it("does not wait at all before the first attempt", () => {
    expect(refreshBackoffMs(0)).toBe(0);
    expect(canRetryRefresh(0, 0)).toBe(true);
  });

  it("backs off 5s, 10s, 20s, 40s and then holds at a minute", () => {
    expect([1, 2, 3, 4, 5, 9].map(refreshBackoffMs)).toEqual([
      5_000, 10_000, 20_000, 40_000, 60_000, 60_000,
    ]);
  });

  it("recovers from a one-off blip on the very next poll", () => {
    const failedAt = 1_000_000;
    // One failure backs off 5s, so the 8-second poll retries straight away —
    // a driver who passed through a tunnel is signed in and working again
    // within seconds, which is the whole point.
    expect(canRetryRefresh(1, failedAt, failedAt + 8_000)).toBe(true);
    expect(canRetryRefresh(1, failedAt, failedAt + 3_000)).toBe(false);
  });

  it("starts skipping polls once failures repeat", () => {
    const failedAt = 1_000_000;
    // Second failure: 10s backoff, so the next 8s poll waits this time.
    expect(canRetryRefresh(2, failedAt, failedAt + 8_000)).toBe(false);
    expect(canRetryRefresh(2, failedAt, failedAt + 10_000)).toBe(true);
  });

  it("stops hammering an endpoint that is rate-limiting us", () => {
    const failedAt = 1_000_000;
    // Four failures in: a poll 30s later still waits (backoff is 40s).
    expect(canRetryRefresh(4, failedAt, failedAt + 30_000)).toBe(false);
    expect(canRetryRefresh(4, failedAt, failedAt + 40_000)).toBe(true);
  });
});
