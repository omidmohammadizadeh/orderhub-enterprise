import { claimResponse, parseJobPush, parseJobResponse } from "./job-push";

const job = { type: "new-job", orderId: "ord_1", title: "New delivery run", body: "2 orders — Accept or Reject" };

describe("parseJobPush", () => {
  it("reads the job from an Android data-only push (dataString)", () => {
    expect(parseJobPush({ notification: null, data: { dataString: JSON.stringify(job) } })).toEqual({
      orderId: "ord_1",
      title: "New delivery run",
      body: "2 orders — Accept or Reject",
    });
  });

  it("falls back to data.body, where Expo puts the same JSON", () => {
    expect(parseJobPush({ data: { body: JSON.stringify(job) } })?.orderId).toBe("ord_1");
  });

  it("ignores pushes that are not a new job", () => {
    expect(parseJobPush({ data: { dataString: JSON.stringify({ type: "chat", orderId: "x" }) } })).toBeNull();
    expect(parseJobPush({ data: { dataString: "not json" } })).toBeNull();
    expect(parseJobPush({ data: { dataString: JSON.stringify({ type: "new-job" }) } })).toBeNull();
    expect(parseJobPush(null)).toBeNull();
  });

  it("still shows something when the title or body is missing", () => {
    const parsed = parseJobPush({ data: { dataString: JSON.stringify({ type: "new-job", orderId: "o" }) } });
    expect(parsed?.title).toBeTruthy();
    expect(parsed?.body).toBeTruthy();
  });
});

describe("parseJobResponse", () => {
  it("reads the listener shape (content.data is an object)", () => {
    const r = parseJobResponse({
      actionIdentifier: "REJECT",
      notification: { request: { identifier: "job-ord_1", content: { data: { orderId: "ord_1" } } } },
    });
    expect(r).toMatchObject({ actionIdentifier: "REJECT", orderId: "ord_1", key: "job-ord_1|REJECT" });
  });

  it("reads the background-task shape (JSON in content.dataString)", () => {
    const r = parseJobResponse({
      actionIdentifier: "REJECT",
      notification: { request: { identifier: "job-ord_1", content: { data: {}, dataString: '{"orderId":"ord_1"}' } } },
    });
    expect(r?.orderId).toBe("ord_1");
  });

  it("has no orderId for the reject-failed follow-up, so tapping it never accepts", () => {
    const r = parseJobResponse({
      actionIdentifier: "expo.modules.notifications.actions.DEFAULT",
      notification: { request: { identifier: "job-ord_1", content: { data: { type: "reject-failed" } } } },
    });
    expect(r?.orderId).toBeNull();
  });

  it("rejects anything without an action", () => {
    expect(parseJobResponse({ notification: {} })).toBeNull();
  });
});

describe("claimResponse", () => {
  it("lets the same tap through once", () => {
    expect(claimResponse("job-x|REJECT")).toBe(true);
    expect(claimResponse("job-x|REJECT")).toBe(false);
    expect(claimResponse("job-x|ACCEPT")).toBe(true);
  });
});
