import { WalkInLoyaltyService } from "../walk-in-loyalty.service";

// A number that already has a card gets a texted code, and the code opens the
// SAME card on the new phone — never the card straight on screen.

const CARD = {
  id: "card-1",
  tenantId: "t1",
  locationId: "loc-1",
  isActive: true,
  walkInEnabled: true,
  stampsRequired: 6,
  minimumSpend: null,
  rewardLabel: "Free coffee",
  rewardExpiryDays: null,
  cardTitle: null,
  cardColor: null,
  cardLogoUrl: null,
  updatedAt: new Date(),
  rewardItem: null,
  location: { id: "loc-1", name: "Pizza Uno", logoUrl: null, currency: "GBP", brand: { logoUrl: null } },
};

const MEMBER = {
  id: "mem-1",
  tenantId: "t1",
  cardId: "card-1",
  locationId: "loc-1",
  code: "ABCD2345",
  publicToken: "tok_".padEnd(32, "x"),
  phone: "+447700900123",
  firstName: "Sam",
  passUpdatedAt: new Date(),
  googleObjectAt: null,
};

function setup(sent = true) {
  let stored: Record<string, unknown> = {};
  const prisma: any = {
    location: { findFirst: jest.fn().mockResolvedValue({ id: "loc-1", name: "Pizza Uno" }) },
    loyaltyCard: { findUnique: jest.fn().mockResolvedValue(CARD) },
    loyaltyMember: {
      findUnique: jest.fn().mockImplementation(({ select }: any) =>
        Promise.resolve(select?.verifyCodeHash ? { ...MEMBER, ...stored } : MEMBER),
      ),
      update: jest.fn().mockImplementation(({ data }: any) => {
        if (data.verifyAttempts?.increment) {
          stored.verifyAttempts = Number(stored.verifyAttempts ?? 0) + 1;
        } else stored = { ...stored, ...data };
        return Promise.resolve({});
      }),
    },
  };
  const sms: any = {
    isConfigured: () => true,
    send: sent ? jest.fn().mockResolvedValue({ ok: true }) : jest.fn().mockRejectedValue(new Error("wallet empty")),
  };
  const svc = new WalkInLoyaltyService(prisma, {} as any, sms, {} as any, {} as any, { emit: jest.fn() } as any);
  const codeFromSms = () => /^(\d{6}) /.exec(sms.send.mock.calls.at(-1)[0].body)![1]!;
  return { svc, sms, codeFromSms };
}

describe("an existing number joining again (new or second phone)", () => {
  it("texts a code instead of showing the card", async () => {
    const { svc, sms } = setup();
    const res = await svc.join("pizza-uno", { phone: "07700 900123" });
    expect(res).toEqual({ status: "VERIFY", phoneHint: "•••• 123" });
    expect(JSON.stringify(res)).not.toContain(MEMBER.publicToken);
    expect(sms.send).toHaveBeenCalledWith(expect.objectContaining({ to: MEMBER.phone }));
  });

  it("opens the same card with the right code", async () => {
    const { svc, codeFromSms } = setup();
    await svc.join("pizza-uno", { phone: "07700900123" });
    await expect(svc.verify("pizza-uno", { phone: "07700900123", code: codeFromSms() })).resolves.toEqual({
      token: MEMBER.publicToken,
    });
  });

  it("refuses a wrong code, and locks after five", async () => {
    const { svc, codeFromSms } = setup();
    await svc.join("pizza-uno", { phone: "07700900123" });
    const right = codeFromSms();
    const wrong = right === "000000" ? "111111" : "000000";
    for (let i = 0; i < 5; i++) {
      await expect(svc.verify("pizza-uno", { phone: "07700900123", code: wrong })).rejects.toThrow(/isn't right/);
    }
    await expect(svc.verify("pizza-uno", { phone: "07700900123", code: right })).rejects.toThrow(/Too many/);
  });

  it("says so honestly when the text cannot be sent", async () => {
    const { svc } = setup(false);
    await expect(svc.join("pizza-uno", { phone: "07700900123" })).resolves.toEqual({
      status: "EXISTING",
      smsSent: false,
    });
  });
});
