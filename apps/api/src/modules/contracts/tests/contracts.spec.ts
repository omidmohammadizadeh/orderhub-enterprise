// The rules that make a contract worth anything.
//
// Three of these guard money or legal standing, and all three fail silently
// if broken: a signed body that follows a later template edit, a subscription
// whose amount comes from the request instead of the contract, and a re-send
// that erases the evidence someone had already read it.

import { ContractsService } from "../contracts.service";

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
