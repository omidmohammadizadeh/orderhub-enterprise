import { buildAutomationQuery } from "../email-audience";
import { EmailAutomationService } from "../email-automation.service";

const NOW = new Date("2026-10-04T12:00:00Z");
const base = {
  tenantId: "t1",
  automationId: "a1",
  locationId: "L1",
  enabledAt: new Date("2026-10-03T12:00:00Z"),
  limit: 1000,
  now: NOW,
};

describe("who an automation emails", () => {
  it("WELCOME: only people who joined after it was switched on, after the delay, never twice", () => {
    const q = buildAutomationQuery({ ...base, type: "WELCOME", delayHours: 2 });
    expect(q.sql).toContain(`COALESCE(ec."consentAt", ec."createdAt") >= $4`);
    expect(q.params[3]).toEqual(base.enabledAt);
    expect(q.params[4]).toEqual(new Date("2026-10-04T10:00:00Z"));
    // ever, across every version of the email
    expect(q.sql).toMatch(/c\."automationId" = \$3 AND r\.email = ec\.email\)/);
  });

  it("WELCOME switched on long ago still never greets someone who joined over a week back", () => {
    const q = buildAutomationQuery({ ...base, type: "WELCOME", enabledAt: new Date("2026-01-01") });
    expect(q.params[3]).toEqual(new Date("2026-09-27T12:00:00Z"));
  });

  it("WIN_BACK: lapsed at THIS shop for N days but within a year, with a cooldown", () => {
    const q = buildAutomationQuery({ ...base, type: "WIN_BACK", days: 45, cooldownDays: 90, brandId: "pizza" });
    expect(q.sql).toContain(`o."locationId" = $2`);
    expect(q.sql).toContain(`o."brandId" = $4`);
    expect(q.params).toContain("pizza");
    expect(q.params).toContainEqual(new Date("2026-08-20T12:00:00Z")); // 45 days
    expect(q.params).toContainEqual(new Date("2025-10-04T12:00:00Z")); // a year
    expect(q.params).toContainEqual(new Date("2026-07-06T12:00:00Z")); // 90-day cooldown
    expect(q.sql).toContain(`ec.status = 'SUBSCRIBED'`);
    expect(q.sql).toContain(`'PENDING','CANCELLED','REJECTED','FAILED'`);
  });
});

function setup(opts: { offerOk?: boolean; due?: any[]; ledger?: any } = {}) {
  const db: any = {
    emailAutomation: { update: jest.fn().mockResolvedValue({}) },
    emailCampaign: {
      findFirst: jest.fn().mockResolvedValue(opts.ledger ?? { id: "led1" }),
      create: jest.fn(),
      update: jest.fn().mockResolvedValue({}),
    },
    emailCampaignRecipient: { createMany: jest.fn().mockResolvedValue({ count: (opts.due ?? []).length }) },
    $queryRawUnsafe: jest.fn().mockResolvedValue(opts.due ?? []),
  };
  const svc: any = {
    db: () => db,
    isEnabled: () => true,
    assertOfferCodesWork: opts.offerOk === false ? jest.fn().mockRejectedValue(new Error("The code X has expired.")) : jest.fn(),
    pauseAutomation: jest.fn(),
    withoutBrokenImages: async (d: any) => ({ design: d, changed: false }),
  };
  return { auto: new EmailAutomationService(svc), db, svc };
}

const automation = {
  id: "a1", tenantId: "t1", locationId: "L1", brandId: null, type: "WIN_BACK", enabled: true,
  enabledAt: new Date(), subject: "We miss you", preheader: null, fromName: null, replyTo: null,
  design: { blocks: [{ id: "x", type: "heading", text: "Hi" }] }, settings: {},
};

describe("an automation run", () => {
  it("pauses itself, and says why, when its offer code stops working", async () => {
    const { auto, svc, db } = setup({ offerOk: false });
    expect(await auto.runOne(automation)).toBe(0);
    expect(svc.pauseAutomation).toHaveBeenCalledWith("a1", "Paused: The code X has expired.");
    expect(db.emailCampaignRecipient.createMany).not.toHaveBeenCalled();
  });

  it("queues whoever is due on the current email's ledger", async () => {
    const due = [{ id: "k1", email: "a@x.com", firstName: "Ann" }, { id: "k2", email: "b@x.com", firstName: null }];
    const { auto, db } = setup({ due });
    expect(await auto.runOne(automation)).toBe(2);
    expect(db.emailCampaignRecipient.createMany).toHaveBeenCalledWith({
      data: [
        expect.objectContaining({ campaignId: "led1", contactId: "k1", status: "PENDING" }),
        expect.objectContaining({ campaignId: "led1", contactId: "k2", status: "PENDING" }),
      ],
      skipDuplicates: true,
    });
    expect(db.emailCampaign.update).toHaveBeenCalledWith({ where: { id: "led1" }, data: { recipientCount: { increment: 2 } } });
  });

  it("does nothing when nobody is due", async () => {
    const { auto, db } = setup({ due: [] });
    expect(await auto.runOne(automation)).toBe(0);
    expect(db.emailCampaign.findFirst).not.toHaveBeenCalled();
  });
});
