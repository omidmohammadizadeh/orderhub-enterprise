import { CustomerAuthService } from "../customer-auth.service";

// The sign-up confirmation email goes back to the site the customer signed up
// on. An Eat For Less sign-up (its website, or the app, which names the site)
// is sent to eatforless.co.uk and reads as Eat For Less, not Order Hub.

function makeService() {
  const created: any[] = [];
  const db = {
    findUnique: jest.fn(async () => null),
    create: jest.fn(async ({ data }: any) => {
      const row = { id: "c1", ...data };
      created.push(row);
      return row;
    }),
  };
  const password = { validateStrength: () => ({ valid: true, errors: [] }), hash: async () => "hashed" };
  const email = { send: jest.fn(async () => undefined) };
  const svc = new CustomerAuthService(
    { customerAccount: db, brand: { findFirst: jest.fn(async () => null) } } as any,
    password as any,
    {} as any,
    email as any,
    { get: (k: string) => (k === "WEB_URL" ? "https://www.orderhubsolutions.com" : undefined) } as any,
  );
  return { svc, email };
}

const signup = { email: "sam@example.com", password: "Passw0rd!", firstName: "Sam", lastName: "Lee" };

describe("sign-up confirmation email", () => {
  it("sends an Eat For Less sign-up back to eatforless.co.uk, as Eat For Less", async () => {
    const { svc, email } = makeService();
    await svc.signup({ ...signup, origin: "https://eatforless.co.uk" } as any);
    const sent = (email.send.mock.calls[0] as any[])[0];
    expect(sent.subject).toBe("Confirm your Eat For Less account");
    expect(sent.html).toMatch(/href="https:\/\/eatforless\.co\.uk\/auth\/confirm\?token=[0-9a-f]{64}"/);
    expect(sent.html).not.toMatch(/Order Hub/);
  });

  it("keeps an OrderHub storefront sign-up as it was", async () => {
    const { svc, email } = makeService();
    await svc.signup({ ...signup, storeSlug: "kingston-pizza" } as any);
    const sent = (email.send.mock.calls[0] as any[])[0];
    expect(sent.subject).toBe("Confirm your Order Hub account");
    expect(sent.html).toMatch(/https:\/\/www\.orderhubsolutions\.com\/order\/kingston-pizza\/auth\/confirm\?token=/);
  });

  it("won't send a confirmation link to a site we don't serve", async () => {
    const { svc, email } = makeService();
    await svc.signup({ ...signup, origin: "https://evil.example" } as any);
    const sent = (email.send.mock.calls[0] as any[])[0];
    expect(sent.html).not.toMatch(/evil\.example/);
  });
});
