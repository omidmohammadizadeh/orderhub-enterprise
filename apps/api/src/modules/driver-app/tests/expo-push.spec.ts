import { ExpoPushService } from "../expo-push.service";

// Android only draws Accept/Reject when the app presents the alert itself, so
// a 1.0.4+ Android install gets a data-only push; everything else keeps the
// alert push it has always had.
describe("ExpoPushService.sendNewJob", () => {
  const job = { orderId: "ord_1", title: "New delivery run", body: "2 orders assigned to you — Accept or Reject" };
  let sent: Record<string, unknown>[];
  const realFetch = global.fetch;

  beforeEach(() => {
    sent = [];
    delete process.env.DRIVER_JOB_PUSH_DATA_ONLY;
    global.fetch = jest.fn(async (_url: unknown, init?: { body?: unknown }) => {
      sent.push(JSON.parse(String(init?.body)));
      return { ok: true, json: async () => ({ data: { status: "ok" } }) };
    }) as unknown as typeof fetch;
  });
  afterAll(() => {
    global.fetch = realFetch;
  });

  it("sends a data-only push to an install that presents job alerts itself", async () => {
    await new ExpoPushService().sendNewJob({ pushToken: "tok", pushJobFormat: "data" }, job);
    expect(sent).toEqual([
      { to: "tok", priority: "high", data: { type: "new-job", orderId: "ord_1", title: job.title, body: job.body } },
    ]);
  });

  it("keeps the alert push with the category for older installs and iOS", async () => {
    await new ExpoPushService().sendNewJob({ pushToken: "tok", pushJobFormat: null }, job);
    expect(sent[0]).toMatchObject({
      to: "tok",
      title: job.title,
      body: job.body,
      categoryId: "new-job",
      channelId: "jobs-v2",
      data: { orderId: "ord_1" },
    });
  });

  it("falls back to the alert push for everyone when the kill switch is off", async () => {
    process.env.DRIVER_JOB_PUSH_DATA_ONLY = "false";
    await new ExpoPushService().sendNewJob({ pushToken: "tok", pushJobFormat: "data" }, job);
    expect(sent[0]).toMatchObject({ title: job.title, categoryId: "new-job" });
  });

  it("sends nothing without a token", async () => {
    await new ExpoPushService().sendNewJob(null, job);
    expect(sent).toEqual([]);
  });
});
