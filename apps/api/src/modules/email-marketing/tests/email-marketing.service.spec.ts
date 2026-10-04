import { EmailMarketingService } from "../email-marketing.service";
import { makeEmailToken } from "../email-tokens";

function make(overrides: Record<string, any> = {}) {
  const prisma: any = {
    emailContact: {
      findUnique: jest.fn(),
      findFirst: jest.fn(),
      update: jest.fn().mockResolvedValue({}),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      create: jest.fn().mockResolvedValue({}),
    },
    emailCampaignRecipient: {
      findUnique: jest.fn(),
      findFirst: jest.fn(),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    emailCampaign: { findUnique: jest.fn(), update: jest.fn().mockResolvedValue({}) },
    brand: { findUnique: jest.fn(), findFirst: jest.fn() },
    ...overrides,
  };
  const config: any = {
    get: (k: string) =>
      ({
        "app.emailMarketing.tokenSecret": "s3cret",
        "app.webUrl": "https://w.example",
      })[k],
  };
  const svc = new EmailMarketingService(prisma, config, {} as any);
  return { svc, prisma };
}

describe("checkout consent", () => {
  it("subscribes a new address", async () => {
    const { svc, prisma } = make();
    prisma.emailContact.findUnique.mockResolvedValue(null);
    await svc.onCheckoutConsent({ tenantId: "t1", email: " Sam@X.com ", firstName: "Sam", locationId: "L1" });
    expect(prisma.emailContact.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ email: "sam@x.com", status: "SUBSCRIBED", consentSource: "checkout", locationId: "L1" }),
    });
  });

  it("the pre-ticked box never undoes an unsubscribe", async () => {
    const { svc, prisma } = make();
    prisma.emailContact.findUnique.mockResolvedValue({ id: "k1", status: "UNSUBSCRIBED" });
    await svc.onCheckoutConsent({ tenantId: "t1", email: "sam@x.com" });
    expect(prisma.emailContact.update).not.toHaveBeenCalled();
    expect(prisma.emailContact.create).not.toHaveBeenCalled();
  });

  it.each(["BOUNCED", "COMPLAINED"])("never re-subscribes a %s address", async (status) => {
    const { svc, prisma } = make();
    prisma.emailContact.findUnique.mockResolvedValue({ id: "k1", status });
    await svc.onCheckoutConsent({ tenantId: "t1", email: "sam@x.com" });
    expect(prisma.emailContact.update).not.toHaveBeenCalled();
    expect(prisma.emailContact.create).not.toHaveBeenCalled();
  });

  it("never throws into the order", async () => {
    const { svc, prisma } = make();
    prisma.emailContact.findUnique.mockRejectedValue(new Error("db down"));
    await expect(svc.onCheckoutConsent({ tenantId: "t1", email: "sam@x.com" })).resolves.toBeUndefined();
  });
});

describe("unsubscribe link", () => {
  it("unsubscribes the contact and counts it once on the campaign", async () => {
    const { svc, prisma } = make();
    prisma.emailCampaignRecipient.findUnique.mockResolvedValue({ id: "r1", contactId: "k1", campaignId: "c1", unsubscribedAt: null });
    prisma.emailContact.findUnique.mockResolvedValue({ id: "k1", status: "SUBSCRIBED", tenantId: "t1" });
    const res = await svc.unsubscribe(makeEmailToken("s3cret", "r", "r1"));
    expect(res).toEqual({ ok: true });
    expect(prisma.emailContact.update).toHaveBeenCalledWith({
      where: { id: "k1" },
      data: expect.objectContaining({ status: "UNSUBSCRIBED" }),
    });
    expect(prisma.emailCampaign.update).toHaveBeenCalledWith({ where: { id: "c1" }, data: { unsubscribeCount: { increment: 1 } } });
  });

  it("refuses a forged token", async () => {
    const { svc, prisma } = make();
    expect(await svc.unsubscribe(makeEmailToken("wrong", "r", "r1"))).toEqual({ ok: false });
    expect(prisma.emailContact.update).not.toHaveBeenCalled();
  });

  it("resubscribe only lifts an UNSUBSCRIBE, never a bounce", async () => {
    const { svc, prisma } = make();
    prisma.emailCampaignRecipient.findUnique.mockResolvedValue({ id: "r1", contactId: "k1", campaignId: "c1" });
    prisma.emailContact.findUnique.mockResolvedValue({ id: "k1", status: "BOUNCED" });
    expect(await svc.resubscribe(makeEmailToken("s3cret", "r", "r1"))).toEqual({ ok: false });
    expect(prisma.emailContact.update).not.toHaveBeenCalled();
  });
});

describe("click tracking", () => {
  const recipient = { id: "r1", campaignId: "c1", contactId: "k1", clickedAt: null, openedAt: null };
  const links = [
    { url: "https://w.example/order/uno", storefront: true },
    { url: "https://instagram.com/uno", storefront: false },
  ];

  it("sends a storefront click on with the attribution marker", async () => {
    const { svc, prisma } = make();
    prisma.emailCampaignRecipient.findUnique.mockResolvedValue(recipient);
    prisma.emailCampaign.findUnique.mockResolvedValue({ id: "c1", links });
    const url = await svc.recordClick("r1", 0);
    expect(url).toBe("https://w.example/order/uno?er=r1&utm_source=email&utm_medium=email&utm_campaign=c1");
    // first click also counts as an open
    expect(prisma.emailCampaign.update).toHaveBeenCalledWith({
      where: { id: "c1" },
      data: { clickCount: { increment: 1 }, openCount: { increment: 1 } },
    });
  });

  it("leaves other sites' links alone and can only go where the email pointed", async () => {
    const { svc, prisma } = make();
    prisma.emailCampaignRecipient.findUnique.mockResolvedValue(recipient);
    prisma.emailCampaign.findUnique.mockResolvedValue({ id: "c1", links });
    expect(await svc.recordClick("r1", 1)).toBe("https://instagram.com/uno");
    expect(await svc.recordClick("r1", 7)).toBe("https://w.example");
  });
});

describe("Resend webhook", () => {
  it("a hard bounce suppresses the address; a soft one does not", async () => {
    const { svc, prisma } = make();
    prisma.emailCampaignRecipient.findFirst.mockResolvedValue({ id: "r1", campaignId: "c1", contactId: "k1" });
    await svc.handleResendEvent({ type: "email.bounced", data: { email_id: "re_1", bounce: { type: "Permanent" } } });
    expect(prisma.emailContact.updateMany).toHaveBeenCalledWith({
      where: { id: "k1", status: { in: ["SUBSCRIBED", "UNSUBSCRIBED"] } },
      data: expect.objectContaining({ status: "BOUNCED" }),
    });

    prisma.emailContact.updateMany.mockClear();
    await svc.handleResendEvent({ type: "email.bounced", data: { email_id: "re_1", bounce: { type: "Transient" } } });
    expect(prisma.emailContact.updateMany).not.toHaveBeenCalled();
  });

  it("a spam complaint suppresses for good", async () => {
    const { svc, prisma } = make();
    prisma.emailCampaignRecipient.findFirst.mockResolvedValue({ id: "r1", campaignId: "c1", contactId: "k1" });
    await svc.handleResendEvent({ type: "email.complained", data: { email_id: "re_1" } });
    expect(prisma.emailContact.updateMany).toHaveBeenCalledWith({
      where: { id: "k1" },
      data: expect.objectContaining({ status: "COMPLAINED" }),
    });
  });

  it("ignores transactional emails it didn't send", async () => {
    const { svc, prisma } = make();
    prisma.emailCampaignRecipient.findFirst.mockResolvedValue(null);
    await svc.handleResendEvent({ type: "email.delivered", data: { email_id: "order-confirmation" } });
    expect(prisma.emailCampaign.update).not.toHaveBeenCalled();
  });
});

describe("order attribution", () => {
  it("only credits a real, recent send to this tenant", async () => {
    const { svc, prisma } = make();
    const sentAt = new Date(Date.now() - 2 * 86400_000);
    prisma.emailCampaignRecipient.findUnique.mockResolvedValue({ id: "r1", tenantId: "t1", campaignId: "c1", sentAt });
    expect(await svc.attributionFor("t1", "r1")).toEqual({ campaignId: "c1", recipientId: "r1" });
    expect(await svc.attributionFor("t2", "r1")).toBeNull();
    prisma.emailCampaignRecipient.findUnique.mockResolvedValue({
      id: "r1", tenantId: "t1", campaignId: "c1", sentAt: new Date(Date.now() - 30 * 86400_000),
    });
    expect(await svc.attributionFor("t1", "r1")).toBeNull();
    expect(await svc.attributionFor("t1", undefined)).toBeNull();
  });
});

describe("failed campaigns", () => {
  function withCampaign(c: any, sent: number) {
    const { svc, prisma } = make({
      emailCampaign: {
        findFirst: jest.fn().mockResolvedValue({ tenantId: "t1", locationId: null, ...c }),
        findUnique: jest.fn(),
        update: jest.fn().mockResolvedValue({}),
        delete: jest.fn().mockResolvedValue({}),
      },
    });
    prisma.emailCampaignRecipient.count = jest.fn().mockResolvedValue(sent);
    prisma.emailCampaignRecipient.deleteMany = jest.fn().mockReturnValue("deleteMany");
    prisma.$transaction = jest.fn().mockResolvedValue([]);
    (svc as any).getCampaign = jest.fn().mockResolvedValue({ id: c.id, status: "DRAFT" });
    const actor = { tenantId: "t1", role: "TENANT_OWNER" };
    return { svc, prisma, actor };
  }
  const failedUnsent = { id: "c1", status: "FAILED", startedAt: new Date(), completedAt: new Date() };

  it("a failure that sent nothing goes back to being a draft", async () => {
    const { svc, prisma, actor } = withCampaign(failedUnsent, 0);
    await svc.retry(actor, "c1");
    expect(prisma.$transaction).toHaveBeenCalled();
    expect(prisma.emailCampaign.update).toHaveBeenCalledWith({
      where: { id: "c1" },
      data: expect.objectContaining({ status: "DRAFT", startedAt: null, completedAt: null, chargedMinor: 0 }),
    });
  });

  it("refuses to retry once anything was sent, but it can still be deleted", async () => {
    const { svc, prisma, actor } = withCampaign(failedUnsent, 3);
    await expect(svc.retry(actor, "c1")).rejects.toThrow("Duplicate it");
    await svc.deleteCampaign(actor, "c1");
    expect(prisma.emailCampaign.delete).toHaveBeenCalled();
  });

  it("won't delete a campaign mid-send", async () => {
    const { svc, prisma, actor } = withCampaign({ id: "c1", status: "SENDING", startedAt: new Date(), completedAt: null }, 0);
    await expect(svc.deleteCampaign(actor, "c1")).rejects.toThrow("Stop it first");
    expect(prisma.emailCampaign.delete).not.toHaveBeenCalled();
  });

  it("a failed campaign that sent nothing can be deleted", async () => {
    const { svc, prisma, actor } = withCampaign(failedUnsent, 0);
    await svc.deleteCampaign(actor, "c1");
    expect(prisma.emailCampaign.delete).toHaveBeenCalledWith({ where: { id: "c1" } });
  });

  it("won't touch a stop that is still in flight", async () => {
    const { svc, actor } = withCampaign({ id: "c1", status: "CANCELLED", startedAt: new Date(), completedAt: null }, 0);
    await expect(svc.retry(actor, "c1")).rejects.toThrow();
    await expect(svc.deleteCampaign(actor, "c1")).rejects.toThrow();
  });
});

describe("the right restaurant's dishes", () => {
  function shop() {
    const { svc, prisma } = make({
      location: { findFirst: jest.fn().mockResolvedValue({ brandId: "pizza" }), findUnique: jest.fn().mockResolvedValue({ currency: "GBP" }) },
      brand: {
        findMany: jest.fn().mockResolvedValue([]),
        findFirst: jest.fn().mockImplementation(({ where }: any) => ({ id: where.id, name: where.id })),
        findUnique: jest.fn(),
      },
      menuChannelAssignment: {
        findMany: jest.fn().mockImplementation(({ where }: any) =>
          where.brandId
            ? [{ menuId: "m-pos", channel: "POS" }, { menuId: "m-online", channel: "ONLINE" }]
            : [{ brandId: "pizza" }],
        ),
      },
      menu: { findMany: jest.fn().mockResolvedValue([]) },
      menuItem: { findMany: jest.fn().mockResolvedValue([]) },
    });
    (svc as any).wallet = { accessibleLocationIds: async () => null };
    return { svc, prisma };
  }

  it("a shop only trades as its own brands", async () => {
    const { svc } = shop();
    expect(await svc.brandIdsAtLocation("t1", "pelton")).toEqual(["pizza"]);
  });

  it("dishes come from the menu that shop serves online, not every menu of the brand", async () => {
    const { svc, prisma } = shop();
    await svc.products({ tenantId: "t1" }, { brandId: "pizza", locationId: "pelton" });
    const where = prisma.menuItem.findMany.mock.calls[0][0].where;
    // Through the menu's categories — MenuItem.menuIds is stale and matched
    // nothing, which sent an email with no dishes at all.
    expect(where.menuIds).toBeUndefined();
    expect(where.categories.some.category.OR).toEqual([
      { menuId: { in: ["m-online"] } },
      { menuIds: { hasSome: ["m-online"] } },
    ]);
    // The menu is already this shop × brand; a master menu's items carry a
    // sibling brand's id, so the brand filter must not also apply.
    expect(where.OR).toBeUndefined();
  });

  it("refuses a brand the shop doesn't sell", async () => {
    const { svc } = shop();
    await expect(
      (svc as any).resolveSender({ tenantId: "t1", role: "TENANT_OWNER" }, "kebab", "pelton"),
    ).rejects.toThrow("isn't sold at this location");
  });
});

describe("offer codes must work before an email goes out", () => {
  const design = (code: string) => ({ blocks: [{ id: "o", type: "offer", title: "20% OFF", code }] });
  function withPromo(promo: any) {
    const { svc } = make({ promoCode: { findFirst: jest.fn().mockResolvedValue(promo) } });
    return svc;
  }
  const c = (code: string) => ({ tenantId: "t1", locationId: "L1", design: design(code) });

  it("refuses the template's sample code that was never created", async () => {
    await expect(withPromo(null).assertOfferCodesWork(c("WEEKEND20"))).rejects.toThrow("doesn't exist yet");
  });
  it("refuses an expired code, and one for another shop", async () => {
    const base = { isActive: true, maxUses: null, usedCount: 0, locationIds: [] as string[] };
    await expect(
      withPromo({ ...base, expiresAt: new Date(Date.now() - 1000) }).assertOfferCodesWork(c("OLD")),
    ).rejects.toThrow("expired");
    await expect(withPromo({ ...base, locationIds: ["L2"] }).assertOfferCodesWork(c("ELSE"))).rejects.toThrow(
      "isn't valid at this shop",
    );
  });
  it("passes a live code, and an offer with no code", async () => {
    const ok = { isActive: true, maxUses: null, usedCount: 0, locationIds: ["L1"], expiresAt: null };
    await expect(withPromo(ok).assertOfferCodesWork(c("WEEKEND20"))).resolves.toBeUndefined();
    await expect(withPromo(null).assertOfferCodesWork(c(""))).resolves.toBeUndefined();
  });
});

describe("photos that won't load", () => {
  afterEach(() => {
    (global as any).fetch = undefined;
  });
  const design = {
    theme: {},
    blocks: [
      {
        id: "p",
        type: "products",
        items: [
          { id: "1", name: "Chips", imageUrl: "/api/v1/menus/hubrise-image/dead1/a" },
          { id: "2", name: "Pizza", imageUrl: "/api/v1/menus/hubrise-image/live1/b" },
          { id: "3", name: "Cola", imageUrl: "https://cdn.example.com/cola.jpg" },
        ],
      },
      { id: "h", type: "hero", imageUrl: "/api/v1/menus/hubrise-image/dead1/c" },
    ],
  } as any;

  it("checks one photo per HubRise catalog and drops the dead catalog's photos", async () => {
    const { svc } = make();
    (global as any).fetch = jest.fn(async (url: string) =>
      url.includes("dead1")
        ? { ok: false, headers: { get: () => "application/json" }, body: null }
        : { ok: true, headers: { get: () => "image/jpeg" }, body: null },
    );
    const { design: out, changed } = await svc.withoutBrokenImages(design);
    expect(changed).toBe(true);
    expect(out.blocks[0].items.map((i: any) => i.imageUrl)).toEqual([
      null,
      "/api/v1/menus/hubrise-image/live1/b",
      "https://cdn.example.com/cola.jpg",
    ]);
    expect((out.blocks[1] as any).imageUrl).toBe("");
    // one request per catalog, none for ordinary https photos
    expect((global as any).fetch).toHaveBeenCalledTimes(2);
  });

  it("leaves a design alone when every photo loads", async () => {
    const { svc } = make();
    (global as any).fetch = jest.fn(async () => ({ ok: true, headers: { get: () => "image/png" }, body: null }));
    expect((await svc.withoutBrokenImages(design)).changed).toBe(false);
  });
});
