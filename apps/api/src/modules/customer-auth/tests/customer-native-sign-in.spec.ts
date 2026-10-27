import { UnauthorizedException } from "@nestjs/common";
import { CustomerAuthService } from "../customer-auth.service";

// Native Google / Apple sign-in from the restaurant apps (apps/customer).
//
//  1. Tokens are checked against the customer apps' own audience lists from
//     the environment, not the staff app's.
//  2. Apple's name arrives once — saved on the first sign-in, never wiped by
//     a later one that has none.
//  3. Linking to an existing account by email needs a provider-verified
//     address, and that address only ever comes from the signed token.

const ENV: Record<string, string> = {
  GOOGLE_CLIENT_ID: "web-client.apps.googleusercontent.com",
  CUSTOMER_APP_GOOGLE_CLIENT_IDS: "ios-kp.apps.googleusercontent.com, android-kp.apps.googleusercontent.com",
  CUSTOMER_APP_APPLE_BUNDLE_IDS: "com.orderhubsolutions.kingstonpizza,com.orderhubsolutions.bestkebabs",
};

function makeService(rows: any[] = []) {
  const db = {
    rows,
    findUnique: jest.fn(async ({ where }: any) => {
      const [key, value] = Object.entries(where)[0] as [string, unknown];
      return rows.find((r) => r[key] === value) ?? null;
    }),
    update: jest.fn(async ({ where, data }: any) => {
      const row = rows.find((r) => r.id === where.id);
      Object.assign(row, data);
      return row;
    }),
    create: jest.fn(async ({ data }: any) => {
      const row = { id: `c${rows.length + 1}`, ...data };
      rows.push(row);
      return row;
    }),
  };
  const nativeOAuth = {
    verifyGoogleIdToken: jest.fn(),
    verifyAppleIdToken: jest.fn(),
  };
  const jwt = { signAsync: jest.fn(async (p: any) => `jwt-for-${p.sub}`) };
  const svc = new CustomerAuthService(
    { customerAccount: db } as any,
    {} as any,
    jwt as any,
    {} as any,
    { get: (k: string) => ENV[k] } as any,
    nativeOAuth as any,
  );
  return { svc, db, nativeOAuth };
}

const appleProfile = (over: Partial<any> = {}) => ({
  provider: "APPLE",
  providerAccountId: "apple-sub-1",
  email: "sam@example.com",
  emailVerified: true,
  firstName: "",
  lastName: "",
  ...over,
});

describe("CustomerAuthService.nativeSignIn — Google", () => {
  it("verifies against the web client plus every listed app client", async () => {
    const { svc, nativeOAuth } = makeService();
    nativeOAuth.verifyGoogleIdToken.mockResolvedValue({
      providerAccountId: "g-1",
      email: "Sam@Example.com",
      emailVerified: true,
      firstName: "Sam",
      lastName: "Lee",
    });
    const out = await svc.nativeSignIn({ provider: "google", idToken: "x".repeat(30) });
    expect(nativeOAuth.verifyGoogleIdToken).toHaveBeenCalledWith("x".repeat(30), [
      "web-client.apps.googleusercontent.com",
      "ios-kp.apps.googleusercontent.com",
      "android-kp.apps.googleusercontent.com",
    ]);
    expect(out.accessToken).toBe("jwt-for-c1");
    expect(out.customer).toMatchObject({ email: "sam@example.com", firstName: "Sam" });
  });

  it("refuses an unverified Google address", async () => {
    const { svc, nativeOAuth, db } = makeService([{ id: "c1", email: "sam@example.com" }]);
    nativeOAuth.verifyGoogleIdToken.mockResolvedValue({
      providerAccountId: "g-1",
      email: "sam@example.com",
      emailVerified: false,
    });
    await expect(
      svc.nativeSignIn({ provider: "google", idToken: "x".repeat(30) }),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(db.update).not.toHaveBeenCalled();
  });
});

describe("CustomerAuthService.nativeSignIn — Apple", () => {
  it("verifies against the listed bundle ids and never trusts an email from the app", async () => {
    const { svc, nativeOAuth } = makeService();
    nativeOAuth.verifyAppleIdToken.mockResolvedValue(appleProfile({ firstName: "Sam" }));
    await svc.nativeSignIn({
      provider: "apple",
      idToken: "x".repeat(30),
      firstName: "Sam",
      lastName: "Lee",
    });
    expect(nativeOAuth.verifyAppleIdToken).toHaveBeenCalledWith(
      "x".repeat(30),
      null,
      { givenName: "Sam", familyName: "Lee" },
      ["com.orderhubsolutions.kingstonpizza", "com.orderhubsolutions.bestkebabs"],
    );
  });

  it("creates the customer with the name Apple gave on the first sign-in", async () => {
    const { svc, nativeOAuth, db } = makeService();
    nativeOAuth.verifyAppleIdToken.mockResolvedValue(
      appleProfile({ firstName: "Sam", lastName: "Lee" }),
    );
    const out = await svc.nativeSignIn({ provider: "apple", idToken: "x".repeat(30) });
    expect(db.rows[0]).toMatchObject({
      appleId: "apple-sub-1",
      email: "sam@example.com",
      firstName: "Sam",
      lastName: "Lee",
      isVerified: true,
    });
    expect(out.accessToken).toBe("jwt-for-c1");
  });

  it("keeps the saved name when a later sign-in has none", async () => {
    const { svc, nativeOAuth, db } = makeService([
      { id: "c1", appleId: "apple-sub-1", email: "sam@example.com", firstName: "Sam", lastName: "Lee" },
    ]);
    nativeOAuth.verifyAppleIdToken.mockResolvedValue(appleProfile());
    await svc.nativeSignIn({ provider: "apple", idToken: "x".repeat(30) });
    expect(db.rows[0]).toMatchObject({ firstName: "Sam", lastName: "Lee" });
    expect(db.create).not.toHaveBeenCalled();
  });

  it("links an existing email account when Apple verifies the address", async () => {
    const { svc, nativeOAuth, db } = makeService([
      { id: "c1", email: "sam@example.com", firstName: "Sam", lastName: "Lee", isVerified: false },
    ]);
    nativeOAuth.verifyAppleIdToken.mockResolvedValue(appleProfile());
    const out = await svc.nativeSignIn({ provider: "apple", idToken: "x".repeat(30) });
    expect(db.rows).toHaveLength(1);
    expect(db.rows[0]).toMatchObject({ appleId: "apple-sub-1", isVerified: true });
    expect(out.accessToken).toBe("jwt-for-c1");
  });

  it("does not link on an address Apple has not verified", async () => {
    const { svc, nativeOAuth, db } = makeService([{ id: "c1", email: "sam@example.com" }]);
    nativeOAuth.verifyAppleIdToken.mockResolvedValue(
      appleProfile({ emailVerified: false, email: "sam@example.com" }),
    );
    // A new row would collide on the unique email; the point is the existing
    // account is never handed over.
    await svc.nativeSignIn({ provider: "apple", idToken: "x".repeat(30) }).catch(() => undefined);
    expect(db.update).not.toHaveBeenCalled();
    expect(db.rows[0].appleId).toBeUndefined();
  });
});
