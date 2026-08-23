import { CareemWebhookLogService } from "../careem-webhook-log.service";

// The webhook endpoint answers 200 whether or not the key matched, so a prober
// learns nothing from it. That also leaves the operator who just configured the
// key with no feedback — this buffer is where they get it.

const entry = (over: Partial<Parameters<CareemWebhookLogService["record"]>[0]> = {}) => ({
  at: new Date().toISOString(),
  eventType: "ORDER_CREATED",
  orderId: 1,
  status: "pending",
  authenticated: true,
  payloadPreview: "{}",
  ...over,
});

describe("CareemWebhookLogService", () => {
  it("returns the newest first", () => {
    const log = new CareemWebhookLogService();
    log.record(entry({ orderId: 1 }));
    log.record(entry({ orderId: 2 }));
    expect(log.recent().map((e) => e.orderId)).toEqual([2, 1]);
  });

  it("records rejected webhooks too — that's the diagnosis", () => {
    // "Webhooks are arriving but none authenticate" is a completely different
    // problem from "nothing is arriving", and only this distinguishes them.
    const log = new CareemWebhookLogService();
    log.record(entry({ authenticated: false }));
    expect(log.recent()).toHaveLength(1);
    expect(log.everAuthenticated).toBe(false);
  });

  it("reports everAuthenticated once one good key arrives", () => {
    const log = new CareemWebhookLogService();
    log.record(entry({ authenticated: false }));
    expect(log.everAuthenticated).toBe(false);
    log.record(entry({ authenticated: true }));
    expect(log.everAuthenticated).toBe(true);
  });

  it("stays capped, so a busy sandbox can't grow memory unbounded", () => {
    const log = new CareemWebhookLogService();
    for (let i = 0; i < 200; i++) log.record(entry({ orderId: i }));
    expect(log.recent(200)).toHaveLength(25);
    expect(log.recent()[0]!.orderId).toBe(199);
  });
});
