import { PauseReopenCron } from "../pause-reopen.cron";
import { REOPEN_LOOKBACK_MS, shouldReopenAfterPause } from "../pause-reopen";

// Deliveroo's status call has no end time, so a timed pause closed the site
// and nothing ever reopened it. The risk in fixing that is reopening a site
// somebody closed BY HAND, which is why the rule is about timing and not
// just "is it closed".

const at = (iso: string) => new Date(iso);
const NOW = at("2026-10-09T15:00:00Z");

describe("shouldReopenAfterPause", () => {
  it("reopens a site whose pause has ended", () => {
    expect(
      shouldReopenAfterPause(
        {
          connectionUpdatedAt: at("2026-10-09T13:00:00Z"), // closed when the pause started
          expiredResumeAts: [at("2026-10-09T14:00:00Z")],
          stillPaused: false,
        },
        NOW,
      ),
    ).toBe(true);
  });

  it("leaves a site alone while any pause still covers it", () => {
    // A 1-hour Deliveroo pause can expire under a location-wide pause that
    // runs until tomorrow. The shop is still shut.
    expect(
      shouldReopenAfterPause(
        {
          connectionUpdatedAt: at("2026-10-09T13:00:00Z"),
          expiredResumeAts: [at("2026-10-09T14:00:00Z")],
          stillPaused: true,
        },
        NOW,
      ),
    ).toBe(false);
  });

  it("never reopens a site that was closed by hand after the pause ended", () => {
    // The operator closed the site from the Deliveroo panel at 14:30, half
    // an hour after the pause ran out. That closure is theirs.
    expect(
      shouldReopenAfterPause(
        {
          connectionUpdatedAt: at("2026-10-09T14:30:00Z"),
          expiredResumeAts: [at("2026-10-09T14:00:00Z")],
          stillPaused: false,
        },
        NOW,
      ),
    ).toBe(false);
  });

  it("ignores pauses that ended long ago", () => {
    const ancient = new Date(NOW.getTime() - REOPEN_LOOKBACK_MS - 60_000);
    expect(
      shouldReopenAfterPause(
        {
          connectionUpdatedAt: at("2020-01-01T00:00:00Z"),
          expiredResumeAts: [ancient],
          stillPaused: false,
        },
        NOW,
      ),
    ).toBe(false);
  });

  it("has nothing to act on when no pause ever expired", () => {
    expect(
      shouldReopenAfterPause(
        {
          connectionUpdatedAt: at("2026-10-09T13:00:00Z"),
          expiredResumeAts: [],
          stillPaused: false,
        },
        NOW,
      ),
    ).toBe(false);
  });
});

describe("the sweep", () => {
  // The cron reads the clock itself, and these fixtures are real dates —
  // pin it, or the suite starts passing and failing by time of day.
  beforeAll(() => {
    jest.useFakeTimers({ doNotFake: ["nextTick"] }).setSystemTime(NOW);
  });
  afterAll(() => jest.useRealTimers());

  const conn = {
    id: "conn-1",
    tenantId: "t1",
    brandId: "b1",
    locationId: "loc-1",
    updatedAt: at("2026-10-09T13:00:00Z"),
    externalStoreId: "800550",
  };

  const build = (opts: {
    paused: boolean;
    expired: Array<{ resumeAt: Date | null }>;
    reopen?: () => Promise<any>;
  }) => {
    const opened: any[] = [];
    const prisma: any = {
      brandPlatformConnection: { findMany: async () => [conn] },
      channelPause: { findMany: async () => opts.expired },
    };
    const deliveroo: any = {
      setStoreOpen: async (...args: any[]) => {
        opened.push(args);
        if (opts.reopen) return opts.reopen();
        return { state: "OPEN", raw: "OPEN" };
      },
    };
    const pauses: any = {
      isPaused: async () => ({ paused: opts.paused, resumeAt: null }),
    };
    return {
      cron: new PauseReopenCron(prisma, deliveroo, pauses),
      opened,
    };
  };

  it("reopens the site, as the store-control adapter", async () => {
    const { cron, opened } = build({
      paused: false,
      expired: [{ resumeAt: at("2026-10-09T14:00:00Z") }],
    });
    await cron.run();
    expect(opened).toEqual([["t1", "conn-1", true]]);
  });

  it("touches nothing while the shop is still paused", async () => {
    const { cron, opened } = build({
      paused: true,
      expired: [{ resumeAt: at("2026-10-09T14:00:00Z") }],
    });
    await cron.run();
    expect(opened).toEqual([]);
  });

  it("swallows a failed reopen so the next run retries it", async () => {
    // The site stays "suspended" on the connection row, so it is still in
    // tomorrow's query — the alternative is marking it done and leaving a
    // shop closed for good.
    const { cron, opened } = build({
      paused: false,
      expired: [{ resumeAt: at("2026-10-09T14:00:00Z") }],
      reopen: () => Promise.reject(new Error("Deliveroo 503")),
    });
    await expect(cron.run()).resolves.toBeUndefined();
    expect(opened).toHaveLength(1);
  });
});
