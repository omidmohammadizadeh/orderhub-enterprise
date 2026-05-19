import axios from "axios";
import {
  parseRetryAfterMs,
  UberEatsSyncClient,
  DeliverooSyncClient,
  HubRiseSyncClient,
  JustEatSyncClient,
} from "./platform-sync.factory";

jest.mock("axios");
const mockedAxios = axios as jest.Mocked<typeof axios>;

function make429Error(retryAfterHeader?: string) {
  const err: any = new Error("Request failed with status code 429");
  err.response = {
    status: 429,
    headers: retryAfterHeader ? { "retry-after": retryAfterHeader } : {},
    data: {},
  };
  return err;
}

function makeHttpError(status: number, message: string) {
  const err: any = new Error(`HTTP ${status}`);
  err.response = { status, headers: {}, data: { message } };
  return err;
}

// ── parseRetryAfterMs ─────────────────────────────────────────────────────────

describe("parseRetryAfterMs", () => {
  it("parses integer seconds", () => {
    expect(parseRetryAfterMs({ "retry-after": "30" })).toBe(30_000);
  });

  it("parses zero seconds as 0", () => {
    expect(parseRetryAfterMs({ "retry-after": "0" })).toBe(0);
  });

  it("parses fractional seconds by ceiling", () => {
    expect(parseRetryAfterMs({ "retry-after": "1.5" })).toBe(2_000);
  });

  it("parses an HTTP-date in the future", () => {
    const future = new Date(Date.now() + 45_000).toUTCString();
    const result = parseRetryAfterMs({ "retry-after": future });
    expect(result).toBeGreaterThan(40_000);
    expect(result).toBeLessThanOrEqual(45_000);
  });

  it("returns 0 for an HTTP-date in the past", () => {
    const past = new Date(Date.now() - 5_000).toUTCString();
    expect(parseRetryAfterMs({ "retry-after": past })).toBe(0);
  });

  it("returns null when header is absent", () => {
    expect(parseRetryAfterMs({})).toBeNull();
  });

  it("returns null for an unparseable value", () => {
    expect(parseRetryAfterMs({ "retry-after": "not-a-date-or-number" })).toBeNull();
  });

  it("accepts Retry-After (capital) key", () => {
    expect(parseRetryAfterMs({ "Retry-After": "10" })).toBe(10_000);
  });
});

// ── UberEatsSyncClient ────────────────────────────────────────────────────────

describe("UberEatsSyncClient", () => {
  let client: UberEatsSyncClient;
  let httpMock: { post: jest.Mock; put: jest.Mock; patch: jest.Mock };
  const credentials = { accessToken: "tok-uber" };

  beforeEach(() => {
    client = new UberEatsSyncClient();
    httpMock = { post: jest.fn(), put: jest.fn(), patch: jest.fn() };
    mockedAxios.create.mockReturnValue(httpMock as any);
  });

  afterEach(() => jest.clearAllMocks());

  it("returns rateLimited:true with retryAfterMs when provider returns 429 + Retry-After", async () => {
    httpMock.post.mockRejectedValue(make429Error("20"));

    const result = await client.syncStatus("ext-001", "ACCEPTED", credentials);

    expect(result.success).toBe(false);
    expect(result.rateLimited).toBe(true);
    expect(result.retryAfterMs).toBe(20_000);
    expect(result.error).toBe("RATE_LIMITED");
  });

  it("returns rateLimited:true without retryAfterMs when Retry-After header is absent", async () => {
    httpMock.post.mockRejectedValue(make429Error());

    const result = await client.syncStatus("ext-001", "ACCEPTED", credentials);

    expect(result.rateLimited).toBe(true);
    expect(result.retryAfterMs).toBeUndefined();
  });

  it("returns success:false (not rateLimited) on non-429 error", async () => {
    httpMock.post.mockRejectedValue(makeHttpError(500, "server error"));

    const result = await client.syncStatus("ext-001", "ACCEPTED", credentials);

    expect(result.success).toBe(false);
    expect(result.rateLimited).toBeUndefined();
    expect(result.error).toBe("server error");
  });

  it("returns success:true for PREPARING (no API call made)", async () => {
    const result = await client.syncStatus("ext-001", "PREPARING", credentials);

    expect(result.success).toBe(true);
    expect(httpMock.post).not.toHaveBeenCalled();
  });

  it("does not create a duplicate call when rate limited — throws once, no retry within syncStatus", async () => {
    httpMock.post.mockRejectedValue(make429Error("5"));

    await client.syncStatus("ext-001", "ACCEPTED", credentials);

    expect(httpMock.post).toHaveBeenCalledTimes(1);
  });
});

// ── DeliverooSyncClient ───────────────────────────────────────────────────────

describe("DeliverooSyncClient", () => {
  let client: DeliverooSyncClient;
  let httpMock: { post: jest.Mock; put: jest.Mock; patch: jest.Mock };
  const credentials = { accessToken: "tok-deliveroo" };

  beforeEach(() => {
    client = new DeliverooSyncClient();
    httpMock = { post: jest.fn(), put: jest.fn(), patch: jest.fn() };
    mockedAxios.create.mockReturnValue(httpMock as any);
  });

  afterEach(() => jest.clearAllMocks());

  it("returns rateLimited:true on 429 with Retry-After header", async () => {
    httpMock.put.mockRejectedValue(make429Error("5"));

    const result = await client.syncStatus("ext-002", "ACCEPTED", credentials);

    expect(result.rateLimited).toBe(true);
    expect(result.retryAfterMs).toBe(5_000);
  });

  it("returns non-rate-limit error on 500", async () => {
    httpMock.put.mockRejectedValue(makeHttpError(500, "deliveroo error"));

    const result = await client.syncStatus("ext-002", "ACCEPTED", credentials);

    expect(result.success).toBe(false);
    expect(result.rateLimited).toBeUndefined();
  });
});

// ── HubRiseSyncClient ─────────────────────────────────────────────────────────

describe("HubRiseSyncClient", () => {
  let client: HubRiseSyncClient;
  let httpMock: { post: jest.Mock; put: jest.Mock; patch: jest.Mock };
  const credentials = { accessToken: "tok-hubrise", accountId: "acc-1", locationId: "loc-1" };

  beforeEach(() => {
    client = new HubRiseSyncClient();
    httpMock = { post: jest.fn(), put: jest.fn(), patch: jest.fn() };
    mockedAxios.create.mockReturnValue(httpMock as any);
  });

  afterEach(() => jest.clearAllMocks());

  it("returns rateLimited:true on 429 with Retry-After header", async () => {
    httpMock.patch.mockRejectedValue(make429Error("15"));

    const result = await client.syncStatus("ext-003", "ACCEPTED", credentials);

    expect(result.rateLimited).toBe(true);
    expect(result.retryAfterMs).toBe(15_000);
  });

  it("returns success:true for unmapped status (no API call)", async () => {
    const result = await client.syncStatus("ext-003", "PENDING" as any, credentials);

    expect(result.success).toBe(true);
    expect(httpMock.patch).not.toHaveBeenCalled();
  });
});

// ── JustEatSyncClient ─────────────────────────────────────────────────────────

describe("JustEatSyncClient", () => {
  let client: JustEatSyncClient;
  let httpMock: { post: jest.Mock; put: jest.Mock; patch: jest.Mock };
  const credentials = { accessToken: "tok-je" };

  beforeEach(() => {
    client = new JustEatSyncClient();
    httpMock = { post: jest.fn(), put: jest.fn(), patch: jest.fn() };
    mockedAxios.create.mockReturnValue(httpMock as any);
  });

  afterEach(() => jest.clearAllMocks());

  it("returns rateLimited:true on 429 with Retry-After as HTTP date", async () => {
    const futureDate = new Date(Date.now() + 60_000).toUTCString();
    httpMock.put.mockRejectedValue(make429Error(futureDate));

    const result = await client.syncStatus("ext-004", "ACCEPTED", credentials);

    expect(result.rateLimited).toBe(true);
    expect(result.retryAfterMs).toBeGreaterThan(50_000);
  });

  it("returns rateLimited without retryAfterMs when Retry-After absent", async () => {
    httpMock.put.mockRejectedValue(make429Error());

    const result = await client.syncStatus("ext-004", "ACCEPTED", credentials);

    expect(result.rateLimited).toBe(true);
    expect(result.retryAfterMs).toBeUndefined();
  });
});
