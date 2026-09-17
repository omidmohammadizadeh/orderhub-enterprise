import { BadRequestException } from "@nestjs/common";
import { UberEatsOauthService } from "../ubereats-oauth.service";

// "Send a connection link to the owner."
//
// Today the operator has to be sitting at the client's Uber login to connect a
// store — which is how the wrong account gets authorised in the first place.
// An invite link moves the consent step to the person who actually owns the
// Uber account: we mint a signed link, they open it, they sign in as
// themselves, and the existing callback does the rest.
//
// The link is a bearer credential for one brand at one shop, so it is signed,
// short-lived, and refuses to run once that brand is already connected.

function harness(opts: { connection?: any; brand?: any; location?: any } = {}) {
  const signed: any[] = [];
  const svc = Object.create(UberEatsOauthService.prototype) as any;

  svc.jwt = {
    sign: jest.fn((payload: any, o: any) => {
      signed.push({ payload, o });
      return `signed:${JSON.stringify(payload)}`;
    }),
    verify: jest.fn((token: string) => {
      if (token.startsWith("signed:")) return JSON.parse(token.slice(7));
      throw new Error("bad token");
    }),
  };
  svc.config = { get: (k: string) => (k === "app.appUrl" ? "https://www.orderhubsolutions.com" : "") };
  svc.prisma = {
    brandPlatformConnection: {
      findFirst: jest.fn().mockResolvedValue(opts.connection ?? null),
    },
    brand: {
      findFirst: jest.fn().mockResolvedValue(opts.brand ?? { id: "b1", name: "Yoyo Burger" }),
    },
    location: {
      findFirst: jest.fn().mockResolvedValue(opts.location ?? { id: "l1", name: "Clifton" }),
    },
  };
  svc.client = {
    configured: true,
    authBase: "https://auth.uber.com/oauth/v2",
    clientId: "cid",
  };
  svc.logger = { log: jest.fn(), warn: jest.fn() };
  Object.defineProperty(svc, "redirectUri", {
    get: () => "https://api.example.com/callback",
  });
  return { svc, signed };
}

describe("Uber Eats — owner connection link", () => {
  it("mints a link the owner can open", async () => {
    const { svc } = harness();
    const out = await svc.createInvite({
      tenantId: "t1",
      brandId: "b1",
      locationId: "l1",
    });

    expect(out.url).toContain("https://www.orderhubsolutions.com/connect/uber-eats/");
    expect(out.expiresAt).toBeTruthy();
  });

  it("signs the link for one brand at one shop, and nothing else", async () => {
    // A link that worked for any brand would let whoever holds it attach an
    // Uber account to a shop it was never meant for.
    const { svc, signed } = harness();
    await svc.createInvite({ tenantId: "t1", brandId: "b1", locationId: "l1" });

    expect(signed[0].payload).toMatchObject({
      t: "t1",
      b: "b1",
      l: "l1",
      purpose: "ubereats_invite",
    });
  });

  it("expires — it is a bearer credential, not a permalink", async () => {
    const { svc, signed } = harness();
    await svc.createInvite({ tenantId: "t1", brandId: "b1", locationId: "l1" });

    expect(signed[0].o.expiresIn).toBeTruthy();
  });

  it("shows the owner which shop they are authorising", async () => {
    const { svc } = harness();
    const { url } = await svc.createInvite({
      tenantId: "t1",
      brandId: "b1",
      locationId: "l1",
    });
    const token = url.split("/").pop()!;

    const view = await svc.describeInvite(decodeURIComponent(token));
    expect(view.brandName).toBe("Yoyo Burger");
    expect(view.locationName).toBe("Clifton");
  });

  it("refuses a link that isn't one of ours", async () => {
    const { svc } = harness();
    await expect(svc.describeInvite("not-a-token")).rejects.toThrow(
      BadRequestException,
    );
  });

  it("refuses an invite minted for a different purpose", async () => {
    // The OAuth state JWT is signed with the same key. Without a purpose check
    // a 15-minute state could be replayed as an invite.
    const { svc } = harness();
    const stateToken = `signed:${JSON.stringify({
      t: "t1",
      b: "b1",
      l: "l1",
      purpose: "ubereats_oauth",
    })}`;
    await expect(svc.describeInvite(stateToken)).rejects.toThrow(
      BadRequestException,
    );
  });

  it("refuses once the brand is already connected", async () => {
    // Effective single use: the link stops working the moment it has done its
    // job, so a forwarded copy can't attach a second Uber account.
    const { svc } = harness({ connection: { id: "c1", status: "connected" } });
    const { url } = await svc.createInvite({
      tenantId: "t1",
      brandId: "b1",
      locationId: "l1",
    });
    const token = url.split("/").pop()!;

    await expect(svc.startInvite(decodeURIComponent(token))).rejects.toThrow(
      /already connected/i,
    );
  });

  it("hands the owner a normal authorize URL, so the callback is unchanged", async () => {
    const { svc } = harness();
    const { url } = await svc.createInvite({
      tenantId: "t1",
      brandId: "b1",
      locationId: "l1",
    });
    const token = url.split("/").pop()!;

    const { authorizeUrl } = await svc.startInvite(decodeURIComponent(token));
    expect(authorizeUrl).toContain("auth.uber.com");
    expect(authorizeUrl).toContain("scope=eats.pos_provisioning");
  });
});
