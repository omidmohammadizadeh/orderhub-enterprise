// The rules that make a contract worth anything.
//
// Three of these guard money or legal standing, and all three fail silently
// if broken: a signed body that follows a later template edit, a subscription
// whose amount comes from the request instead of the contract, and a re-send
// that erases the evidence someone had already read it.

import { ContractsService } from "../contracts.service";
import { STARTER_TEMPLATES } from "../starter-templates";

const TENANT = "t1";

function makeService(opts: { contract?: any; template?: any } = {}) {
  const contracts: any[] = [];
  const events: any[] = [];
  const setPlanCalls: any[] = [];
  let current = opts.contract ?? null;

  const svc = Object.create(ContractsService.prototype) as any;
  svc.logger = { log() {}, warn() {}, error() {} };
  svc.config = { get: () => "https://app.example.com" };
  svc.email = { send: async () => ({ id: "e1" }) };
  svc.subscriptions = {
    setPlan: async (...args: any[]) => {
      setPlanCalls.push(args);
      return { checkoutUrl: "https://checkout.stripe.com/x" };
    },
  };
  svc.prisma = {
    contractTemplate: {
      findFirst: async () => opts.template ?? null,
    },
    location: {
      findFirst: async () => ({ id: "loc1", name: "Pizza Uno" }),
    },
    contract: {
      create: async ({ data }: any) => {
        const row = { id: "c1", ...data, location: { id: "loc1", name: "Pizza Uno" } };
        contracts.push(row);
        current = row;
        return row;
      },
      findFirst: async () => current,
      findUnique: async () => current,
      update: async ({ data }: any) => {
        current = { ...current, ...data, location: { id: "loc1", name: "Pizza Uno" } };
        return current;
      },
    },
    contractEvent: {
      create: async ({ data }: any) => {
        events.push(data);
        return data;
      },
    },
  };
  return { svc, contracts, events, setPlanCalls, latest: () => current };
}

const signedContract = (over: Record<string, any> = {}) => ({
  id: "c1",
  tenantId: TENANT,
  token: "tok",
  status: "SIGNED",
  title: "Service agreement",
  recipientEmail: "client@example.com",
  signerEmail: "signer@example.com",
  locationId: "loc1",
  subscriptionAmountPence: 4900,
  ...over,
});

describe("contract body is frozen at creation", () => {
  it("copies the template body onto the contract", async () => {
    const { svc, latest } = makeService({
      template: {
        id: "tpl1",
        name: "Standard",
        bodyHtml: "<p>Fee is {{amount}} for {{location}}</p>",
        subscriptionAmountPence: 4900,
      },
    });
    await svc.create(TENANT, {
      templateId: "tpl1",
      recipientName: "Sam Patel",
      recipientEmail: "sam@example.com",
      locationId: "loc1",
    });
    // Substituted NOW, not at render time — an operator editing the template
    // tomorrow must not change what someone signed today.
    expect(latest().bodyHtml).toBe("<p>Fee is £49.00 for Pizza Uno</p>");
  });

  it("leaves an unknown placeholder alone rather than blanking it", async () => {
    // Blanking would silently delete a clause; leaving it visible is obvious
    // in the preview and gets fixed before anyone signs.
    const { svc, latest } = makeService({
      template: { id: "t", name: "T", bodyHtml: "<p>{{whoKnows}}</p>" },
    });
    await svc.create(TENANT, {
      templateId: "t",
      recipientName: "A",
      recipientEmail: "a@b.co",
    });
    expect(latest().bodyHtml).toBe("<p>{{whoKnows}}</p>");
  });

  it("refuses a contract with neither body nor file", async () => {
    const { svc } = makeService({ template: { id: "t", name: "T" } });
    await expect(
      svc.create(TENANT, {
        templateId: "t",
        recipientName: "A",
        recipientEmail: "a@b.co",
      }),
    ).rejects.toThrow(/written content or an uploaded file/i);
  });
});

describe("signing", () => {
  it("records name, IP and user-agent as the evidence", async () => {
    const { svc, events } = makeService({
      contract: signedContract({ status: "OPENED", signerName: null }),
    });
    await svc.sign(
      "tok",
      { signerName: "  Sam Patel  " },
      { ip: "203.0.113.9", userAgent: "Safari/1" },
    );
    const signed = events.find((e) => e.type === "SIGNED");
    expect(signed.ip).toBe("203.0.113.9");
    expect(signed.userAgent).toBe("Safari/1");
  });

  it("refuses to sign twice", async () => {
    const { svc } = makeService({ contract: signedContract() });
    await expect(
      svc.sign("tok", { signerName: "Someone Else" }),
    ).rejects.toThrow(/already been signed/i);
  });

  it("refuses to sign a withdrawn contract", async () => {
    const { svc } = makeService({
      contract: signedContract({ status: "VOIDED" }),
    });
    await expect(svc.sign("tok", { signerName: "Sam" })).rejects.toThrow(
      /withdrawn/i,
    );
  });

  it("refuses an empty name", async () => {
    const { svc } = makeService({
      contract: signedContract({ status: "SENT" }),
    });
    await expect(svc.sign("tok", { signerName: "   " })).rejects.toThrow(
      /type your full name/i,
    );
  });
});

describe("sharing by link rather than email", () => {
  it("issues a DRAFT so the copied link can actually be signed", async () => {
    // The bug this pins: the dashboard used to copy signingUrl straight off
    // the row. It looked like it worked and didn't — a DRAFT is not signable,
    // so the client opened the page, typed their name and was told the
    // contract wasn't ready. Handing over a link must issue it.
    const { svc, latest } = makeService({
      contract: signedContract({ status: "DRAFT", sentAt: null }),
    });
    const res = await svc.send(TENANT, "c1", { emailIt: false });
    expect(latest().status).toBe("SENT");
    expect(res.signingUrl).toContain("/contract/tok");
  });

  it("issued-by-link contracts are then signable", async () => {
    const { svc, latest } = makeService({
      contract: signedContract({ status: "DRAFT", sentAt: null }),
    });
    await svc.send(TENANT, "c1", { emailIt: false });
    await expect(
      svc.sign("tok", { signerName: "Sam Patel" }),
    ).resolves.toMatchObject({ status: "SIGNED" });
    expect(latest().signerName).toBe("Sam Patel");
  });

  it("does not email when the operator asked for a link", async () => {
    const { svc } = makeService({
      contract: signedContract({ status: "DRAFT", sentAt: null }),
    });
    const sent: any[] = [];
    svc.email = { send: async (o: any) => (sent.push(o), { id: "e" }) };
    await svc.send(TENANT, "c1", { emailIt: false });
    expect(sent).toHaveLength(0);
  });

  it("still emails when the operator asked for email", async () => {
    const { svc } = makeService({
      contract: signedContract({ status: "DRAFT", sentAt: null }),
    });
    const sent: any[] = [];
    svc.email = { send: async (o: any) => (sent.push(o), { id: "e" }) };
    await svc.send(TENANT, "c1", { emailIt: true });
    expect(sent).toHaveLength(1);
    expect(sent[0].to).toBe("client@example.com");
  });
});

describe("re-sending keeps the evidence", () => {
  it("does not reset OPENED back to SENT", async () => {
    // Rolling the status back would erase the record that they had already
    // read it — the single most useful fact in a signature dispute.
    const { svc, latest } = makeService({
      contract: signedContract({
        status: "OPENED",
        sentAt: new Date("2026-01-01"),
        firstOpenedAt: new Date("2026-01-02"),
      }),
    });
    await svc.send(TENANT, "c1", { emailIt: false });
    expect(latest().status).toBe("OPENED");
    expect(latest().firstOpenedAt).toEqual(new Date("2026-01-02"));
  });

  it("keeps the original sentAt on a reminder", async () => {
    const original = new Date("2026-01-01");
    const { svc, latest } = makeService({
      contract: signedContract({ status: "SENT", sentAt: original }),
    });
    await svc.send(TENANT, "c1", { emailIt: false });
    expect(latest().sentAt).toEqual(original);
  });
});

describe("subscribe button", () => {
  it("takes the amount and location from the CONTRACT, not the request", async () => {
    // The whole safety of a public subscribe endpoint rests on this: whoever
    // holds the link chooses only whether to press the button.
    const { svc, setPlanCalls } = makeService({ contract: signedContract() });
    await svc.startSubscription("tok");
    const [tenantId, locationId, amount] = setPlanCalls[0];
    expect(tenantId).toBe(TENANT);
    expect(locationId).toBe("loc1");
    expect(amount).toBe(4900);
  });

  it("refuses before the contract is signed", async () => {
    const { svc, setPlanCalls } = makeService({
      contract: signedContract({ status: "OPENED" }),
    });
    await expect(svc.startSubscription("tok")).rejects.toThrow(/sign/i);
    expect(setPlanCalls).toHaveLength(0);
  });

  it("refuses when the contract carries no subscription", async () => {
    const { svc } = makeService({
      contract: signedContract({ subscriptionAmountPence: null }),
    });
    await expect(svc.startSubscription("tok")).rejects.toThrow(
      /doesn't include a subscription/i,
    );
  });

  it("refuses when no location is attached to subscribe", async () => {
    const { svc } = makeService({ contract: signedContract({ locationId: null }) });
    await expect(svc.startSubscription("tok")).rejects.toThrow(
      /doesn't include a subscription/i,
    );
  });
});

describe("first open", () => {
  it("flips SENT to OPENED and stamps the time once", async () => {
    const { svc, latest } = makeService({
      contract: signedContract({ status: "SENT", firstOpenedAt: null }),
    });
    await svc.getByToken("tok", { ip: "1.2.3.4" });
    expect(latest().status).toBe("OPENED");
    expect(latest().firstOpenedAt).toBeInstanceOf(Date);
  });

  it("does not offer Subscribe until signed", async () => {
    const { svc } = makeService({
      contract: signedContract({ status: "OPENED" }),
    });
    const view = await svc.getByToken("tok");
    expect(view.canSubscribe).toBe(false);
  });
});

describe("voiding", () => {
  it("refuses to void a signed contract", async () => {
    const { svc } = makeService({ contract: signedContract() });
    await expect(svc.void(TENANT, "c1")).rejects.toThrow(/already been agreed/i);
  });
});


describe("optional commercial terms", () => {
  const withBody = (bodyHtml: string) => ({
    template: { id: "t", name: "T", bodyHtml },
  });
  const CLAUSES =
    "<p>Sub {{amount}}</p>" +
    "{{#commission}}<p>Commission {{commission}}</p>{{/commission}}" +
    "{{#serviceCharge}}<p>Charge {{serviceCharge}}</p>{{/serviceCharge}}";

  const create = async (dto: Record<string, any>) => {
    const { svc, latest } = makeService(withBody(CLAUSES));
    await svc.create(TENANT, {
      templateId: "t",
      recipientName: "Sam",
      recipientEmail: "sam@b.co",
      ...dto,
    });
    return latest();
  };

  it("REMOVES the commission clause when left blank", async () => {
    // Not "0%". A term negotiated down to nothing and a term that was never
    // offered read very differently to whoever is signing, and a blank box
    // means the second.
    const c = await create({ subscriptionAmountPence: 4900 });
    expect(c.bodyHtml).not.toContain("Commission");
    expect(c.bodyHtml).toContain("Sub £49.00");
  });

  it("includes the commission clause with the agreed rate", async () => {
    const c = await create({ commissionPercent: 2.5 });
    expect(c.bodyHtml).toContain("Commission 2.5%");
  });

  it("treats zero as 'does not apply', not as a zero rate", async () => {
    const c = await create({ commissionPercent: 0 });
    expect(c.bodyHtml).not.toContain("Commission");
  });

  it("REMOVES the customer service charge when left blank", async () => {
    const c = await create({ commissionPercent: 2 });
    expect(c.bodyHtml).toContain("Commission");
    expect(c.bodyHtml).not.toContain("Charge");
  });

  it("includes the service charge in pounds", async () => {
    const c = await create({ customerServiceChargePence: 50 });
    expect(c.bodyHtml).toContain("Charge £0.50");
  });

  it("can include both, or neither", async () => {
    const both = await create({
      commissionPercent: 3,
      customerServiceChargePence: 99,
    });
    expect(both.bodyHtml).toContain("Commission 3%");
    expect(both.bodyHtml).toContain("Charge £0.99");

    const neither = await create({});
    expect(neither.bodyHtml).not.toContain("Commission");
    expect(neither.bodyHtml).not.toContain("Charge");
  });

  it("stores what was agreed, so the record matches the document", async () => {
    const c = await create({
      commissionPercent: 2.5,
      customerServiceChargePence: 50,
    });
    expect(c.commissionPercent).toBe(2.5);
    expect(c.customerServiceChargePence).toBe(50);
  });

  it("refuses a commission over 100%", async () => {
    const { svc } = makeService(withBody(CLAUSES));
    await expect(
      svc.create(TENANT, {
        templateId: "t",
        recipientName: "Sam",
        recipientEmail: "sam@b.co",
        commissionPercent: 150,
      }),
    ).rejects.toThrow(/more than 100/i);
  });
});


describe("amending a contract after it was sent", () => {
  const sent = (over: Record<string, any> = {}) => ({
    ...signedContract({ status: "SENT", signerName: null }),
    recipientName: "Sam Patel",
    recipientCompany: "Patel Foods Ltd",
    createdAt: new Date("2026-08-01T10:00:00Z"),
    sourceHtml:
      "<p>Sub {{amount}}</p>{{#commission}}<p>Commission {{commission}}</p>{{/commission}}",
    bodyHtml: "<p>Sub £49.00</p>",
    commissionPercent: null,
    customerServiceChargePence: null,
    ...over,
  });

  it("REFUSES to change a signed contract", async () => {
    // The whole value of the thing. An edit here would rewrite terms someone
    // is already bound by.
    const { svc } = makeService({ contract: sent({ status: "SIGNED" }) });
    await expect(
      svc.update(TENANT, "c1", { subscriptionAmountPence: 100 }),
    ).rejects.toThrow(/signed and can no longer be changed/i);
  });

  it("refuses to change a withdrawn contract", async () => {
    const { svc } = makeService({ contract: sent({ status: "VOIDED" }) });
    await expect(
      svc.update(TENANT, "c1", { subscriptionAmountPence: 100 }),
    ).rejects.toThrow(/withdrawn/i);
  });

  it("re-renders the body from the ORIGINAL wording, not the live template", async () => {
    // Re-fetching the template would drag in every unrelated edit made to it
    // since — changing clauses nobody meant to touch.
    const { svc, latest } = makeService({ contract: sent() });
    await svc.update(TENANT, "c1", { subscriptionAmountPence: 9900 });
    expect(latest().bodyHtml).toBe("<p>Sub £99.00</p>");
  });

  it("can add a clause that was left out originally", async () => {
    const { svc, latest } = makeService({ contract: sent() });
    await svc.update(TENANT, "c1", { commissionPercent: 3 });
    expect(latest().bodyHtml).toContain("Commission 3%");
  });

  it("can remove a clause by blanking it", async () => {
    const { svc, latest } = makeService({
      contract: sent({ commissionPercent: 5 }),
    });
    await svc.update(TENANT, "c1", { commissionPercent: null });
    expect(latest().bodyHtml).not.toContain("Commission");
  });

  it("rolls OPENED back to SENT and records that they had already read it", async () => {
    // They may have read different terms to the ones they end up signing.
    // The board must stop claiming they have seen the current version, and
    // the audit trail is the only place that fact can live.
    const { svc, latest, events } = makeService({
      contract: sent({ status: "OPENED", firstOpenedAt: new Date() }),
    });
    await svc.update(TENANT, "c1", { subscriptionAmountPence: 5900 });
    expect(latest().status).toBe("SENT");
    const amended = events.find((e) => e.type === "AMENDED");
    expect(amended.meta.wasOpened).toBe(true);
  });

  it("keeps the signing token, so links already sent still work", async () => {
    const { svc, latest } = makeService({ contract: sent() });
    await svc.update(TENANT, "c1", { recipientName: "Samantha Patel" });
    expect(latest().token).toBe("tok");
  });

  it("leaves untouched fields alone", async () => {
    const { svc, latest } = makeService({ contract: sent() });
    await svc.update(TENANT, "c1", { recipientName: "Samantha Patel" });
    expect(latest().recipientName).toBe("Samantha Patel");
    expect(latest().recipientCompany).toBe("Patel Foods Ltd");
    expect(latest().subscriptionAmountPence).toBe(4900);
  });

  it("updates the figures even when there is no stored wording", async () => {
    // Contracts created before sourceHtml existed. The record must still be
    // correctable; only the body can't be re-rendered.
    const { svc, latest } = makeService({
      contract: sent({ sourceHtml: null, bodyHtml: "<p>Old body</p>" }),
    });
    await svc.update(TENANT, "c1", { subscriptionAmountPence: 7900 });
    expect(latest().subscriptionAmountPence).toBe(7900);
    expect(latest().bodyHtml).toBe("<p>Old body</p>");
  });

  it("refuses to blank the recipient", async () => {
    const { svc } = makeService({ contract: sent() });
    await expect(
      svc.update(TENANT, "c1", { recipientName: "   " }),
    ).rejects.toThrow(/name and email are required/i);
  });
});


describe("client details fill the parties clause", () => {
  const PARTIES =
    "<p>{{recipientCompany}}" +
    "{{#recipientCompanyNumber}}, company number {{recipientCompanyNumber}}{{/recipientCompanyNumber}}" +
    "{{#recipientAddress}}, of {{recipientAddress}}{{/recipientAddress}}" +
    ", by {{recipientName}} ({{recipientEmail}}" +
    "{{#recipientPhone}}, {{recipientPhone}}{{/recipientPhone}})</p>" +
    "{{#locationWord}}<p>Covers {{locationWord}}.</p>{{/locationWord}}";

  const create = async (dto: Record<string, any>) => {
    const { svc, latest } = makeService({
      template: { id: "t", name: "T", bodyHtml: PARTIES },
    });
    await svc.create(TENANT, {
      templateId: "t",
      recipientName: "Sam Patel",
      recipientEmail: "sam@patelfoods.co.uk",
      recipientCompany: "Patel Foods Ltd",
      ...dto,
    });
    return latest().bodyHtml as string;
  };

  it("fills every client detail when given", async () => {
    const body = await create({
      recipientCompanyNumber: "12345678",
      recipientAddress: "7 Front Street, Pelton, DH2 1DD",
      recipientPhone: "0191 123 4567",
      locationCount: 3,
    });
    expect(body).toContain("company number 12345678");
    expect(body).toContain("of 7 Front Street, Pelton, DH2 1DD");
    expect(body).toContain("0191 123 4567");
    expect(body).toContain("Covers 3 locations.");
  });

  it("leaves NO dangling label when a detail is missing", async () => {
    // A sole trader has no company number. ", company number ," in a document
    // someone is about to sign reads as a broken system.
    const body = await create({});
    expect(body).not.toContain("company number");
    expect(body).not.toContain(", of ");
    expect(body).toContain("Patel Foods Ltd");
    expect(body).toContain("sam@patelfoods.co.uk");
  });

  it("says '1 location', not '1 locations'", async () => {
    const body = await create({ locationCount: 1 });
    expect(body).toContain("Covers 1 location.");
    expect(body).not.toContain("1 locations");
  });

  it("omits the location line entirely when not given", async () => {
    const body = await create({});
    expect(body).not.toContain("Covers");
  });

  it("stores the details so the record matches the document", async () => {
    const { svc, latest } = makeService({
      template: { id: "t", name: "T", bodyHtml: PARTIES },
    });
    await svc.create(TENANT, {
      templateId: "t",
      recipientName: "Sam",
      recipientEmail: "s@b.co",
      recipientCompanyNumber: "12345678",
      recipientPhone: "0191 123 4567",
      locationCount: 2,
    });
    expect(latest().recipientCompanyNumber).toBe("12345678");
    expect(latest().recipientPhone).toBe("0191 123 4567");
    expect(latest().locationCount).toBe(2);
  });
});


describe("the SHIPPED agreement renders end to end", () => {
  // The gap that let a bug through: every other test here uses a synthetic
  // template, so they all passed while the real agreement went out with its
  // fee clauses missing. These run the actual wording we ship.
  const saas = () =>
    STARTER_TEMPLATES.find((t) => t.key === "saas-agreement")!.bodyHtml;

  const create = async (dto: Record<string, any>) => {
    const { svc, latest } = makeService({
      template: {
        id: "t",
        name: "SaaS Agreement — full",
        bodyHtml: saas(),
      },
    });
    await svc.create(TENANT, {
      templateId: "t",
      recipientName: "Sam Patel",
      recipientEmail: "sam@patelfoods.co.uk",
      recipientCompany: "Patel Foods Ltd",
      subscriptionAmountPence: 4900,
      ...dto,
    });
    return latest().bodyHtml as string;
  };

  it("prints the commission clause with the agreed rate", async () => {
    const body = await create({ commissionPercent: 2.5 });
    expect(body).toContain("Order commission");
    expect(body).toContain("2.5%");
  });

  it("prints the customer service charge clause", async () => {
    const body = await create({ customerServiceChargePence: 50 });
    expect(body).toContain("Customer service charge");
    expect(body).toContain("£0.50");
  });

  it("prints both when both are set", async () => {
    const body = await create({
      commissionPercent: 3,
      customerServiceChargePence: 99,
    });
    expect(body).toContain("3%");
    expect(body).toContain("£0.99");
  });

  it("omits both when neither is set", async () => {
    const body = await create({});
    expect(body).not.toContain("Order commission");
    expect(body).not.toContain("Customer service charge");
  });

  it("leaves NO unrendered template syntax behind", async () => {
    // An unclosed or misspelled section shows up as literal {{#…}} in a
    // document a client is reading.
    const body = await create({
      commissionPercent: 2,
      customerServiceChargePence: 50,
      recipientCompanyNumber: "12345678",
      recipientAddress: "7 Front Street",
      recipientPhone: "0191 123 4567",
      locationCount: 2,
    });
    expect(body).not.toMatch(/\{\{[#/]/);
    expect(body).not.toMatch(/\{\{\s*\w+\s*\}\}/);
  });

  it("fills the subscription and the notice period", async () => {
    const body = await create({});
    expect(body).toContain("£49.00 per month");
    expect(body).toMatch(/one month's written notice/i);
  });
});


describe("deleting a contract", () => {
  const row = (over: Record<string, any> = {}) => ({
    ...signedContract(over),
    deletedAt: null,
  });

  it("is soft — the record and its audit trail survive", async () => {
    // A signed contract records an agreement somebody is bound by, and its
    // events are the evidence behind it. Tidying a list must not destroy
    // either.
    const { svc, latest } = makeService({ contract: row({ status: "SIGNED" }) });
    await svc.remove(TENANT, "c1");
    expect(latest().deletedAt).toBeInstanceOf(Date);
  });

  it("records WHAT it was when deleted", async () => {
    const { svc, events } = makeService({ contract: row({ status: "SENT" }) });
    await svc.remove(TENANT, "c1");
    const ev = events.find((e) => e.type === "DELETED");
    expect(ev.meta.statusWhenDeleted).toBe("SENT");
  });

  it("can delete a draft, a sent one and a signed one", async () => {
    for (const status of ["DRAFT", "SENT", "OPENED", "SIGNED", "VOIDED"]) {
      const { svc } = makeService({ contract: row({ status }) });
      await expect(svc.remove(TENANT, "c1")).resolves.toEqual({
        deleted: true,
      });
    }
  });

  it("refuses one that is already deleted", async () => {
    // findFirst filters deletedAt: null, so a second delete finds nothing
    // rather than silently re-stamping the timestamp.
    const { svc } = makeService({ contract: null });
    await expect(svc.remove(TENANT, "c1")).rejects.toThrow(/not found/i);
  });
});
