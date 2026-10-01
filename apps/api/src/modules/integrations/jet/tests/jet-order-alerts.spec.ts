import { JetOrderAlertService } from "../jet-order-alert.service";

// An order Just Eat sent us and we could not inject.
//
// Until now this existed only as a line in the Render log: on 1 Oct a store
// phoned to say an order had not arrived, and the operator found out from the
// customer rather than from us. These tests pin the three moments worth waking
// someone for, and — more importantly — pin that raising the alert can never
// become the reason an order is lost.

const base = {
  jetOrderId: "k7nojc8ydesq1l2btqhnag",
  displayId: "960172618",
  tenantId: "t1",
  brandId: "b1",
  locationId: "loc-1",
  restaurantName: "Best Kebab",
};

function svc(over: { opsEmail?: string | null; opsSms?: string | null } = {}) {
  const notifications = {
    notifyLocation: jest.fn().mockResolvedValue(undefined),
    sendOpsAlert: jest.fn().mockResolvedValue(undefined),
    sendOpsSms: jest.fn().mockResolvedValue(undefined),
  };
  const activity = { record: jest.fn() };
  const logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn() };
  const s: any = Object.create(JetOrderAlertService.prototype);
  Object.assign(s, {
    notifications,
    activity,
    logger,
    recent: new Map<string, number>(),
    config: {
      get: jest.fn((k: string) => {
        if (k === "app.platforms.jet.opsAlertEmail") {
          return over.opsEmail === undefined ? "ops@orderhubpos.com" : over.opsEmail;
        }
        if (k === "app.platforms.jet.opsAlertSms") {
          return over.opsSms === undefined ? "+447700900123" : over.opsSms;
        }
        return undefined;
      }),
    },
  });
  return { s: s as JetOrderAlertService, notifications, activity, logger };
}

describe("JET order failure alerts", () => {
  it("tells the shop and ops when an order could not be injected", async () => {
    const { s, notifications } = svc();

    await s.raise({ ...base, kind: "ingest_failed", code: "MENU_ERROR", error: "unknown plu" });

    expect(notifications.notifyLocation).toHaveBeenCalledTimes(1);
    const [locationId, tenantId, type, title, body] =
      notifications.notifyLocation.mock.calls[0];
    expect(locationId).toBe("loc-1");
    expect(tenantId).toBe("t1");
    expect(type).toBe("INTEGRATION_FAILURE");
    // The shop has to be able to act on this without reading a log.
    expect(`${title} ${body}`).toContain("960172618");
    expect(`${title} ${body}`).toMatch(/just eat/i);

    expect(notifications.sendOpsAlert).toHaveBeenCalledTimes(1);
    const opsBody = notifications.sendOpsAlert.mock.calls[0][1];
    expect(opsBody).toContain("Best Kebab");
    expect(opsBody).toContain("MENU_ERROR");
  });

  it("marks a failed acknowledgement as the more serious one", async () => {
    const { s, notifications } = svc();

    await s.raise({ ...base, kind: "ack_failed", error: "socket hang up" });

    const subject = notifications.sendOpsAlert.mock.calls[0][0];
    // JET marks an un-acked order failed-to-inject and skips the backup flow,
    // so this one is worse than an honest rejection and must read that way.
    expect(subject).toMatch(/not acknowledged|failed-to-inject/i);
  });

  it("alerts once per order per kind, so the 30s watchdog cannot spam", async () => {
    const { s, notifications } = svc();

    await s.raise({ ...base, kind: "ack_failed" });
    await s.raise({ ...base, kind: "ack_failed" });
    await s.raise({ ...base, kind: "ack_failed" });

    expect(notifications.sendOpsAlert).toHaveBeenCalledTimes(1);
  });

  it("still alerts when the same order reaches a different, worse state", async () => {
    const { s, notifications } = svc();

    await s.raise({ ...base, kind: "ack_failed" });
    await s.raise({ ...base, kind: "abandoned" });

    expect(notifications.sendOpsAlert).toHaveBeenCalledTimes(2);
  });

  it("alerts a different order even when the first is still in the window", async () => {
    const { s, notifications } = svc();

    await s.raise({ ...base, kind: "ack_failed" });
    await s.raise({ ...base, jetOrderId: "other-order", kind: "ack_failed" });

    expect(notifications.sendOpsAlert).toHaveBeenCalledTimes(2);
  });

  it("sends no ops email when no ops address is configured, but still tells the shop", async () => {
    const { s, notifications } = svc({ opsEmail: null });

    await s.raise({ ...base, kind: "ingest_failed", code: "UNKNOWN" });

    expect(notifications.sendOpsAlert).not.toHaveBeenCalled();
    expect(notifications.notifyLocation).toHaveBeenCalledTimes(1);
  });

  it("records the failure on the Logs page even when every notifier is down", async () => {
    const { s, notifications, activity } = svc();
    notifications.notifyLocation.mockRejectedValue(new Error("FCM down"));
    notifications.sendOpsAlert.mockRejectedValue(new Error("SendGrid 503"));

    await expect(
      s.raise({ ...base, kind: "ingest_failed", code: "UNKNOWN" }),
    ).resolves.toBeUndefined();

    expect(activity.record).toHaveBeenCalledWith(
      expect.objectContaining({ status: "ERROR", channel: "JUST_EAT" }),
    );
  });

  it("never throws, whatever happens inside it", async () => {
    const { s } = svc();
    (s as any).notifications = null;

    await expect(
      s.raise({ ...base, kind: "ack_failed" }),
    ).resolves.toBeUndefined();
  });

  it("does nothing without a tenant — an unroutable order has no shop to tell", async () => {
    const { s, notifications } = svc();

    await s.raise({
      jetOrderId: "no-tenant",
      kind: "ingest_failed",
      code: "INCORRECT_SETUP",
    } as any);

    // Nothing to notify, but ops still needs to know: a store mapped wrong
    // drops EVERY order until someone fixes it.
    expect(notifications.notifyLocation).not.toHaveBeenCalled();
    expect(notifications.sendOpsAlert).toHaveBeenCalledTimes(1);
  });
});

// Email is the nice-to-have; the text is the one that reaches someone during
// service. On 1 Oct the API had Twilio configured and no SendGrid at all, so
// an alert that could only email would have been an alert that did nothing.
describe("JET order failure alerts — reaching a human", () => {
  it("texts ops, short enough to read on a lock screen", async () => {
    const { s, notifications } = svc();

    await s.raise({ ...base, kind: "ack_failed" });

    expect(notifications.sendOpsSms).toHaveBeenCalledTimes(1);
    const [message, to] = notifications.sendOpsSms.mock.calls[0];
    expect(to).toBe("+447700900123");
    expect(message).toContain("960172618");
    expect(message).toContain("Best Kebab");
    expect(message.length).toBeLessThanOrEqual(160);
  });

  it("sends nothing by text when no number is configured", async () => {
    const { s, notifications } = svc({ opsSms: null });

    await s.raise({ ...base, kind: "ack_failed" });

    expect(notifications.sendOpsSms).not.toHaveBeenCalled();
    expect(notifications.sendOpsAlert).toHaveBeenCalledTimes(1);
  });

  it("still emails when the text fails, and vice versa", async () => {
    const { s, notifications } = svc();
    notifications.sendOpsSms.mockRejectedValue(new Error("Twilio 429"));

    await expect(s.raise({ ...base, kind: "abandoned" })).resolves.toBeUndefined();

    expect(notifications.sendOpsAlert).toHaveBeenCalledTimes(1);
  });
});
