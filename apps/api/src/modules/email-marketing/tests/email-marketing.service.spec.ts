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

  it("a fresh tick re-subscribes someone who unsubscribed", async () => {
    const { svc, prisma } = make();
    prisma.emailContact.findUnique.mockResolvedValue({ id: "k1", status: "UNSUBSCRIBED" });
    await svc.onCheckoutConsent({ tenantId: "t1", email: "sam@x.com" });
    expect(prisma.emailContact.update).toHaveBeenCalledWith({
      where: { id: "k1" },
      data: expect.objectContaining({ status: "SUBSCRIBED", consentSource: "checkout", unsubscribedAt: null }),
    });
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
