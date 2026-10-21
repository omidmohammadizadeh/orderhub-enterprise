import { salonEmail, salonReminderSms } from "../salon-emails";
import { SalonRemindersCron } from "../salon-reminders.cron";

const base = {
  shopName: "Fade & Co",
  logoUrl: null,
  address: "1 High St, London",
  shopPhone: "020 7946 0000",
  timezone: "Europe/London",
  currency: "GBP",
  customerName: "Liam <Carter>",
  staffName: "Jay",
  summary: "Skin fade (+ Beard trim)",
  startsAt: new Date("2026-10-14T09:00:00Z"),
  durationMins: 45,
  totalPrice: 30,
  priceFrom: false,
  depositAmount: 10,
  depositStatus: "PAID",
  reference: "S-ABC234",
  patchTest: false,
  manageUrl: "https://x.test/salon/booking/tok",
  bookUrl: "https://x.test/salon/loc",
  cancellationWindowHours: 24,
};

describe("salon emails", () => {
  it("confirms in the shop's own time, escapes the name, and links the manage page", () => {
    const m = salonEmail({ ...base, kind: "confirmed" });
    expect(m.subject).toBe("Booked — Fade & Co, Wednesday, 14 October 2026 at 10:00");
    expect(m.html).toContain("Hi Liam,");
    expect(m.html).not.toContain("<Carter>");
    expect(m.html).toContain("https://x.test/salon/booking/tok");
    expect(m.html).toContain("£10.00 deposit paid");
    expect(m.text).toContain("Reference: S-ABC234");
  });

  it("says refunded when a deposit went back", () => {
    const m = salonEmail({ ...base, kind: "cancelled", depositStatus: "REFUNDED" });
    expect(m.html).toContain("deposit refunded to your card");
    expect(m.html).toContain("Book again");
  });

  it("warns about patch tests, but not on a cancellation", () => {
    expect(salonEmail({ ...base, kind: "confirmed", patchTest: true }).html).toContain("patch test");
    expect(salonEmail({ ...base, kind: "cancelled", patchTest: true }).html).not.toContain("patch test");
  });

  it("asks for a review with the shop's link and no booking details", () => {
    const m = salonEmail({ ...base, kind: "review", reviewUrl: "https://g.page/r/abc/review" });
    expect(m.html).toContain("https://g.page/r/abc/review");
    expect(m.html).not.toContain("S-ABC234");
    expect(m.text).toContain("Leave a review: https://g.page/r/abc/review");
  });

  it("keeps the reminder text short", () => {
    const t = salonReminderSms({
      shopName: "Fade & Co",
      startsAt: new Date("2026-10-14T09:00:00Z"),
      timezone: "Europe/London",
      staffName: "Jay",
      manageUrl: "https://x.test/b/tok",
    });
    expect(t).toBe("Fade & Co: reminder of your appointment Wed 14 Oct at 10:00 with Jay. Change/cancel: https://x.test/b/tok");
  });
});

// ── Reminders cron, against an in-memory table ─────────────────────────────

function fakePrisma(rows: any[], loc: { settings: any; timezone: string; googleReviewUrl?: string | null }) {
  const match = (r: any, where: any): boolean =>
    Object.entries(where ?? {}).every(([k, v]: [string, any]) => {
      if (k === "OR") return (v as any[]).some((w) => match(r, w));
      if (v && typeof v === "object" && !(v instanceof Date)) {
        if ("not" in v) return v.not === null ? r[k] != null : r[k] !== v.not;
        if ("in" in v) return (v.in as any[]).includes(r[k]);
        if ("gt" in v || "lt" in v) {
          const t = r[k] instanceof Date ? r[k].getTime() : null;
          if (t === null) return false;
          if (v.gt && !(t > v.gt.getTime())) return false;
          if (v.lt && !(t < v.lt.getTime())) return false;
          return true;
        }
      }
      return r[k] === v;
    });
  return {
    location: { findUnique: async () => loc },
    salonAppointment: {
      findMany: async ({ where }: any) => rows.filter((r) => match(r, where)),
      count: async ({ where }: any) => rows.filter((r) => match(r, where)).length,
      updateMany: async ({ where, data }: any) => {
        const hit = rows.filter((r) => match(r, where));
        hit.forEach((r) => Object.assign(r, data));
        return { count: hit.length };
      },
    },
  } as any;
}

describe("salon reminders cron", () => {
  const now = Date.parse("2026-10-13T12:00:00Z"); // 13:00 BST — daytime
  const H = 3600_000;
  const notify = () => {
    const sent: string[] = [];
    return {
      sent,
      appointmentNow: async (kind: string, id: string) => {
        sent.push(`${kind}:${id}`);
        return true;
      },
      reminderSms: async (id: string) => {
        sent.push(`sms:${id}`);
        return true;
      },
    } as any;
  };

  it("reminds inside the window once, skips ones booked inside it, and texts when switched on", async () => {
    const rows = [
      { id: "a", locationId: "L", status: "CONFIRMED", reminderSentAt: null, startsAt: new Date(now + 20 * H), createdAt: new Date(now - 72 * H), customerEmail: "a@x.com", customerPhone: "07700900001" },
      { id: "b", locationId: "L", status: "CONFIRMED", reminderSentAt: null, startsAt: new Date(now + 30 * H), createdAt: new Date(now - 72 * H), customerEmail: "b@x.com", customerPhone: null },
      { id: "c", locationId: "L", status: "CONFIRMED", reminderSentAt: null, startsAt: new Date(now + 5 * H), createdAt: new Date(now - 1 * H), customerEmail: "c@x.com", customerPhone: null },
    ];
    const n = notify();
    const cron = new SalonRemindersCron(fakePrisma(rows, { settings: { salon: { reminderSms: true } }, timezone: "Europe/London" }), n);
    expect(await cron.reminders(now)).toBe(1);
    expect(n.sent).toEqual(["reminder:a", "sms:a"]);
    expect(rows.find((r) => r.id === "c")!.reminderSentAt).not.toBeNull(); // claimed, not sent
    expect(rows.find((r) => r.id === "b")!.reminderSentAt).toBeNull(); // not due yet
    expect(await cron.reminders(now)).toBe(0); // never twice
  });

  it("nudges a lapsed client once, but not one who's already booked again", async () => {
    const day = 86_400_000;
    const rows = [
      { id: "old", locationId: "L", tenantId: "T", status: "COMPLETED", rebookNudgeSentAt: null, completedAt: new Date(now - 22 * day), customerEmail: "lapsed@x.com" },
      { id: "keen", locationId: "L", tenantId: "T", status: "COMPLETED", rebookNudgeSentAt: null, completedAt: new Date(now - 22 * day), customerEmail: "keen@x.com" },
      { id: "keen-next", locationId: "L", tenantId: "T", status: "CONFIRMED", rebookNudgeSentAt: null, completedAt: null, customerEmail: "keen@x.com" },
    ];
    const n = notify();
    const cron = new SalonRemindersCron(
      fakePrisma(rows, { settings: { salon: { rebookAfterDays: 21, onlineBookingEnabled: true } }, timezone: "Europe/London" }),
      n,
    );
    expect(await cron.rebookNudges(now)).toBe(1);
    expect(n.sent).toEqual(["rebook:old"]);
  });

  it("asks for a review only with a review link, and only in the daytime", async () => {
    const mk = () => [
      { id: "v", locationId: "L", status: "COMPLETED", reviewRequestSentAt: null, completedAt: new Date(now - 3 * H), customerEmail: "v@x.com" },
    ];
    const withLink = { settings: { salon: {} }, timezone: "Europe/London", googleReviewUrl: "https://g.page/r/x/review" };
    let n = notify();
    expect(await new SalonRemindersCron(fakePrisma(mk(), withLink), n).reviewRequests(now)).toBe(1);
    n = notify();
    expect(await new SalonRemindersCron(fakePrisma(mk(), { ...withLink, googleReviewUrl: null }), n).reviewRequests(now)).toBe(0);
    n = notify();
    const night = Date.parse("2026-10-13T22:30:00Z");
    const rows = mk().map((r) => ({ ...r, completedAt: new Date(night - 3 * H) }));
    expect(await new SalonRemindersCron(fakePrisma(rows, withLink), n).reviewRequests(night)).toBe(0);
    expect(rows[0]!.reviewRequestSentAt).toBeNull(); // waits for morning
  });
});
