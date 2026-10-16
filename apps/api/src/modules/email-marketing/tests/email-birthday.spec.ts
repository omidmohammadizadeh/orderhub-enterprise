import { personalise } from "@orderhub/shared";
import { birthdayKeys, localDate, localHour, offerExpiresLabel, shopTimezone } from "../birthday";
import { buildAutomationQuery } from "../email-audience";
import { EmailAutomationService } from "../email-automation.service";

describe("whose birthday is it", () => {
  it("is today's month and day", () => {
    expect(birthdayKeys({ year: 2026, month: 10, day: 16 })).toEqual(["10-16"]);
  });

  it("celebrates a 29 February birthday on 28 February in a non-leap year", () => {
    expect(birthdayKeys({ year: 2027, month: 2, day: 28 })).toEqual(["02-28", "02-29"]);
    // …and not on 1 March
    expect(birthdayKeys({ year: 2027, month: 3, day: 1 })).toEqual(["03-01"]);
  });

  it("celebrates it on the day itself in a leap year, and only once", () => {
    expect(birthdayKeys({ year: 2028, month: 2, day: 28 })).toEqual(["02-28"]);
    expect(birthdayKeys({ year: 2028, month: 2, day: 29 })).toEqual(["02-29"]);
    // 1900 and 2100 are not leap years; 2000 was
    expect(birthdayKeys({ year: 2100, month: 2, day: 28 })).toContain("02-29");
    expect(birthdayKeys({ year: 2000, month: 2, day: 28 })).toEqual(["02-28"]);
  });
});

describe("the shop's calendar, not the server's", () => {
  // 21:30 UTC on 15 March: still the 15th in London, already the 16th in Dubai.
  const lateEvening = new Date("2027-03-15T21:30:00Z");

  it("dates today in the shop's timezone", () => {
    expect(localDate(lateEvening, "Europe/London")).toEqual({ year: 2027, month: 3, day: 15 });
    expect(localDate(lateEvening, "Asia/Dubai")).toEqual({ year: 2027, month: 3, day: 16 });
    expect(localHour(lateEvening, "Asia/Dubai")).toBe(1);
  });

  it("follows British Summer Time", () => {
    // 23:30 UTC on 30 June is 00:30 on 1 July in London.
    expect(localDate(new Date("2027-06-30T23:30:00Z"), "Europe/London")).toEqual({ year: 2027, month: 7, day: 1 });
  });

  it("takes the zone from the country when the row is still on the UK default", () => {
    expect(shopTimezone({ timezone: "Europe/London", country: "AE" })).toBe("Asia/Dubai");
    expect(shopTimezone({ timezone: null, country: "SA" })).toBe("Asia/Riyadh");
    expect(shopTimezone({ timezone: "Europe/London", country: "GB" })).toBe("Europe/London");
    // an operator's explicit choice wins
    expect(shopTimezone({ timezone: "Europe/Madrid", country: "GB" })).toBe("Europe/Madrid");
  });

  it("dates the offer from the birthday, counting the day itself", () => {
    expect(offerExpiresLabel({ year: 2026, month: 10, day: 16 }, 7)).toBe("22 October");
    expect(offerExpiresLabel({ year: 2026, month: 12, day: 28 }, 7)).toBe("3 January");
    expect(offerExpiresLabel({ year: 2026, month: 10, day: 16 }, 1)).toBe("16 October");
    expect(personalise("Valid until {{offer_expires}}.", { offerExpires: "22 October" })).toBe("Valid until 22 October.");
  });
});

describe("who a birthday automation emails", () => {
  const q = buildAutomationQuery({
    tenantId: "t1",
    automationId: "a1",
    type: "BIRTHDAY",
    locationId: "L1",
    brandId: "pizza",
    enabledAt: new Date(),
    birthdayKeys: ["02-28", "02-29"],
    birthdayYear: 2027,
    limit: 1000,
  });

  it("only subscribed contacts of THIS tenant — never the account's global opt-in", () => {
    expect(q.sql).toContain(`ec."tenantId" = $1`);
    expect(q.sql).toContain(`ec.status = 'SUBSCRIBED'`);
    expect(q.sql).not.toContain("marketingOptIn");
  });

  it("only people with a real order at this shop and brand", () => {
    expect(q.sql).toContain(`s.email IS NOT NULL`);
    expect(q.sql).toContain(`o."locationId" = $2`);
    expect(q.sql).toContain(`o."brandId" = $4`);
    expect(q.sql).toContain(`'PENDING','CANCELLED','REJECTED','FAILED'`);
  });

  it("matches the date of birth against today's keys", () => {
    expect(q.sql).toMatch(/to_char\(ca\."dateOfBirth", 'MM-DD'\) = ANY\(\$5::text\[\]\)/);
    expect(q.params[4]).toEqual(["02-28", "02-29"]);
  });

  it("skips anyone this automation already claimed this year", () => {
    expect(q.sql).toMatch(/email_birthday_sends b\s+WHERE b\."automationId" = \$3 AND b\.email = ec\.email AND b\.year = \$6/);
    expect(q.params[5]).toBe(2027);
  });

  it("refuses to run without a date", () => {
    expect(() =>
      buildAutomationQuery({ tenantId: "t1", automationId: "a1", type: "BIRTHDAY", locationId: "L1", enabledAt: new Date(), limit: 10 }),
    ).toThrow();
  });
});

function setup(opts: { due: any[]; claimed: string[]; tz?: string; country?: string }) {
  const db: any = {
    emailAutomation: { update: jest.fn().mockResolvedValue({}) },
    emailCampaign: {
      findFirst: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockImplementation(({ data }: any) => Promise.resolve({ id: "led1", ...data })),
      update: jest.fn().mockResolvedValue({}),
    },
    emailCampaignRecipient: { createMany: jest.fn().mockImplementation(({ data }: any) => Promise.resolve({ count: data.length })) },
    location: { findUnique: jest.fn().mockResolvedValue({ timezone: opts.tz ?? "Europe/London", country: opts.country ?? "GB" }) },
    $queryRawUnsafe: jest.fn().mockImplementation((sql: string) =>
      Promise.resolve(sql.includes("INSERT INTO email_birthday_sends") ? opts.claimed.map((email) => ({ email })) : opts.due),
    ),
  };
  const svc: any = {
    db: () => db,
    isEnabled: () => true,
    assertOfferCodesWork: jest.fn(),
    pauseAutomation: jest.fn(),
    withoutBrokenImages: async (d: any) => ({ design: d, changed: false }),
    renderContext: async () => ({ brandName: "Pizza", storefrontUrl: "https://x", unsubscribeUrl: "" }),
  };
  return { auto: new EmailAutomationService(svc), db };
}

const birthday = {
  id: "a1", tenantId: "t1", locationId: "L1", brandId: null, type: "BIRTHDAY", enabled: true,
  enabledAt: new Date(), subject: "Happy birthday", preheader: null, fromName: null, replyTo: null,
  design: { blocks: [{ id: "x", type: "heading", text: "Hi" }] }, settings: { validDays: 7 },
};
const due = [
  { id: "k1", email: "a@x.com", firstName: "Ann" },
  { id: "k2", email: "b@x.com", firstName: "Bo" },
];

describe("a birthday run", () => {
  it("queues only the people this run claimed — once a year, even with two ticks at once", async () => {
    // b@x.com was claimed by an overlapping tick a moment ago.
    const { auto, db } = setup({ due, claimed: ["a@x.com"] });
    expect(await auto.runOne(birthday, new Date("2026-10-16T09:15:00Z"))).toBe(1);
    const [insertSql, ...args] = db.$queryRawUnsafe.mock.calls[1];
    expect(insertSql).toContain(`ON CONFLICT ("automationId", email, year) DO NOTHING`);
    expect(args[3]).toBe(2026);
    expect(args[6]).toEqual(["a@x.com", "b@x.com"]);
    expect(db.emailCampaignRecipient.createMany).toHaveBeenCalledWith({
      data: [expect.objectContaining({ email: "a@x.com", contactId: "k1" })],
      skipDuplicates: true,
    });
  });

  it("queues nobody when everyone is already claimed", async () => {
    const { auto, db } = setup({ due, claimed: [] });
    expect(await auto.runOne(birthday, new Date("2026-10-16T09:15:00Z"))).toBe(0);
    expect(db.emailCampaignRecipient.createMany).not.toHaveBeenCalled();
  });

  it("keeps one ledger per year, so next year's birthday isn't a duplicate of this one", async () => {
    const { auto, db } = setup({ due, claimed: ["a@x.com"] });
    await auto.runOne(birthday, new Date("2026-10-16T09:15:00Z"));
    await auto.runOne(birthday, new Date("2027-10-16T09:15:00Z"));
    const [y1, y2] = db.emailCampaign.findFirst.mock.calls.map((c: any) => c[0].where.templateId);
    expect(y1).toMatch(/^auto:[0-9a-f]{16}:2026$/);
    expect(y2).toMatch(/^auto:[0-9a-f]{16}:2027$/);
    expect(db.emailCampaign.create.mock.calls[0][0].data.audience).toEqual({ offerValidDays: 7 });
  });

  it("uses the shop's date: late evening UTC is already tomorrow in Dubai", async () => {
    const { auto, db } = setup({ due, claimed: ["a@x.com"], country: "AE" });
    await auto.runOne(birthday, new Date("2027-02-27T21:00:00Z"));
    const params = db.$queryRawUnsafe.mock.calls[0].slice(1);
    expect(params).toContainEqual(["02-28", "02-29"]);
    expect(params).toContain(2027);
  });
});
