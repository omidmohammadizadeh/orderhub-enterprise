import { ResendError } from "../../../infrastructure/email/email.service";
import { EmailCampaignSenderService } from "../email-campaign-sender.service";

// The sender's promises: suppressed people are dropped before a FIRST send,
// a retry reuses the exact batch + key, push-back leaves rows for later, and
// the campaign is closed once with the unsent part refunded.

function setup(opts: { rows: any[]; subscribed: string[]; sendBatch?: jest.Mock }) {
  const recipientUpdates: any[] = [];
  const db: any = {
    emailCampaignRecipient: {
      findMany: jest.fn().mockResolvedValue(opts.rows),
      updateMany: jest.fn().mockImplementation((a: any) => (recipientUpdates.push(a), { count: 1 })),
      update: jest.fn().mockResolvedValue({}),
      count: jest.fn(),
      findFirst: jest.fn(),
    },
    emailContact: {
      findMany: jest.fn().mockResolvedValue(opts.subscribed.map((id) => ({ id }))),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    emailCampaign: {
      update: jest.fn().mockResolvedValue({}),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      findUnique: jest.fn(),
    },
  };
  const svc: any = {
    db: () => db,
    isEnabled: () => true,
    fromAddress: () => "Offers <offers@mail.example.com>",
    apiBase: () => "https://w.example/api/v1/email-marketing",
    unsubscribeUrl: (t: string) => `https://w.example/email/unsubscribe?t=${t}`,
    makeRecipientToken: (id: string) => `tok-${id}`,
    pricePer1000Minor: () => 300,
    renderContext: jest.fn().mockResolvedValue({
      brandName: "Pizza Uno",
      logoUrl: null,
      storefrontUrl: "https://w.example/order/uno",
      footerAddress: "1 High St",
    }),
  };
  const wallet: any = { refundEmailMarketing: jest.fn().mockResolvedValue(true) };
  const email: any = { sendBatch: opts.sendBatch ?? jest.fn().mockResolvedValue({ ids: ["re_1", "re_2"] }) };
  const sender = new EmailCampaignSenderService(svc, wallet, email);
  return { sender, db, wallet, email, recipientUpdates };
}

const campaign = {
  id: "c1",
  tenantId: "t1",
  locationId: "L1",
  status: "SENDING",
  subject: "Hi {{first_name}}",
  preheader: null,
  replyTo: null,
  design: { theme: {}, blocks: [{ id: "b", type: "button", label: "Order", url: "{{storefront}}" }] },
};

const rows = [
  { id: "r1", contactId: "k1", email: "a@x.com", firstName: "Ann" },
  { id: "r2", contactId: "k2", email: "b@x.com", firstName: null },
  { id: "r3", contactId: "k3", email: "c@x.com", firstName: "Cy" },
];

describe("EmailCampaignSenderService.sendBatch", () => {
  it("drops people who unsubscribed since the list was made, then sends the rest under the batch key", async () => {
    const { sender, email, db } = setup({ rows, subscribed: ["k1", "k2"] });
    const ok = await (sender as any).sendBatch(campaign, await (sender as any).svc.renderContext(), "key-1", false);
    expect(ok).toBe(true);
    expect(db.emailCampaignRecipient.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ["r3"] } },
      data: { status: "SKIPPED", error: "no_longer_subscribed" },
    });
    const [emails, key] = email.sendBatch.mock.calls[0];
    expect(key).toBe("key-1");
    expect(emails.map((e: any) => e.to)).toEqual(["a@x.com", "b@x.com"]);
    expect(emails[0].subject).toBe("Hi Ann");
    expect(emails[1].subject).toBe("Hi there");
    expect(emails[0].headers["List-Unsubscribe-Post"]).toBe("List-Unsubscribe=One-Click");
    expect(emails[0].headers["List-Unsubscribe"]).toContain("tok-r1");
    expect(emails[0].html).toContain("https://w.example/api/v1/email-marketing/c/r1/0");
    expect(emails[0].html).toContain("https://w.example/api/v1/email-marketing/o/r1");
    expect(db.emailCampaignRecipient.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "r1" }, data: expect.objectContaining({ status: "SENT", resendId: "re_1" }) }),
    );
    expect(db.emailCampaign.update).toHaveBeenCalledWith({ where: { id: "c1" }, data: { sentCount: { increment: 2 } } });
  });

  it("a RETRY sends exactly the claimed rows — no re-filtering, or Resend would refuse the reused key", async () => {
    const { sender, email, db } = setup({ rows, subscribed: [] });
    await (sender as any).sendBatch(campaign, await (sender as any).svc.renderContext(), "key-1", true);
    expect(db.emailContact.findMany).not.toHaveBeenCalled();
    expect(email.sendBatch.mock.calls[0][0]).toHaveLength(3);
  });

  it("leaves rows SENDING when Resend pushes back, so the stuck-batch path retries them", async () => {
    const sendBatch = jest.fn().mockRejectedValue(new ResendError("slow down", 429));
    const { sender, db } = setup({ rows: rows.slice(0, 2), subscribed: ["k1", "k2"], sendBatch });
    const ok = await (sender as any).sendBatch(campaign, await (sender as any).svc.renderContext(), "key-1", false);
    expect(ok).toBe(false);
    expect(db.emailCampaignRecipient.update).not.toHaveBeenCalled();
    expect(db.emailCampaign.update).not.toHaveBeenCalled();
  });

  it("marks a batch Resend rejected outright as FAILED", async () => {
    const sendBatch = jest.fn().mockRejectedValue(new ResendError("bad from", 422));
    const { sender, db } = setup({ rows: rows.slice(0, 2), subscribed: ["k1", "k2"], sendBatch });
    const ok = await (sender as any).sendBatch(campaign, await (sender as any).svc.renderContext(), "key-1", false);
    expect(ok).toBe(true);
    expect(db.emailCampaignRecipient.updateMany).toHaveBeenCalledWith({
      where: { batchKey: "key-1", status: "SENDING" },
      data: { status: "FAILED", error: "bad from" },
    });
  });
});

describe("EmailCampaignSenderService.finishIfDone", () => {
  function finishing(counts: Record<string, number>, campaignRow: any, closed = 1) {
    const s = setup({ rows: [], subscribed: [] });
    s.db.emailCampaignRecipient.count.mockImplementation(({ where }: any) =>
      where.status?.in ? (counts.OPEN ?? 0) : (counts[where.status] ?? 0),
    );
    s.db.emailCampaign.findUnique.mockResolvedValue(campaignRow);
    s.db.emailCampaign.updateMany.mockResolvedValue({ count: closed });
    return s;
  }

  it("does nothing while rows are still waiting", async () => {
    const { sender, db } = finishing({ OPEN: 4 }, {});
    await sender.finishIfDone(campaign);
    expect(db.emailCampaign.updateMany).not.toHaveBeenCalled();
  });

  it("refunds the paid emails that never went out", async () => {
    // 2,000 recipients, 500 free, 1,500 paid = 450p charged. 1,800 sent:
    // 1,300 of them paid = 390p kept, 60p back.
    const { sender, db, wallet } = finishing(
      { SENT: 1800, FAILED: 150, SKIPPED: 50 },
      { freeUsed: 500, chargedMinor: 450, refundedMinor: 0 },
    );
    await sender.finishIfDone(campaign);
    expect(db.emailCampaign.updateMany).toHaveBeenCalledWith({
      where: { id: "c1", completedAt: null },
      data: expect.objectContaining({ status: "SENT", sentCount: 1800, refundedMinor: { increment: 60 } }),
    });
    expect(wallet.refundEmailMarketing).toHaveBeenCalledWith(expect.objectContaining({ amountMinor: 60, locationId: "L1" }));
  });

  it("refunds nothing when everything unsent was inside the free allowance", async () => {
    const { sender, wallet } = finishing({ SENT: 900, SKIPPED: 100 }, { freeUsed: 1000, chargedMinor: 0, refundedMinor: 0 });
    await sender.finishIfDone(campaign);
    expect(wallet.refundEmailMarketing).not.toHaveBeenCalled();
  });

  it("never refunds twice — the close is the guard", async () => {
    const { sender, wallet } = finishing({ SENT: 0, FAILED: 10 }, { freeUsed: 0, chargedMinor: 3, refundedMinor: 0 }, 0);
    await sender.finishIfDone(campaign);
    expect(wallet.refundEmailMarketing).not.toHaveBeenCalled();
  });
});
