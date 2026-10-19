import { BadRequestException, NotFoundException } from "@nestjs/common";
import { readSocialLogin, SocialLoginService } from "../social-login.service";

// Admin Dashboard → Social login: which sign-in buttons each restaurant app
// shows. Off unless switched on; iOS Google never without iOS Apple (App Store
// guideline 4.8); the rest of Brand.settings is left alone.

function makeService(brands: any[]) {
  const prisma = {
    brand: {
      findFirst: jest.fn(async ({ where }: any) => brands.find((b) => b.id === where.id) ?? null),
      findMany: jest.fn(async () => brands),
      update: jest.fn(async ({ where, data }: any) => {
        const b = brands.find((x) => x.id === where.id);
        Object.assign(b, data);
        return b;
      }),
    },
    customerPushSubscription: {
      groupBy: jest.fn(async () => [{ brandId: "kp", appId: "com.orderhubsolutions.kingstonpizza" }]),
    },
  } as any;
  return { svc: new SocialLoginService(prisma), prisma };
}

const brand = (id: string, name: string, settings: unknown = {}) => ({
  id,
  name,
  logoUrl: null,
  settings,
  tenant: { name: "KLO" },
  locations: [],
});

describe("readSocialLogin", () => {
  it("is all off when nothing is stored", () => {
    expect(readSocialLogin({})).toEqual({ ios: { apple: false, google: false }, android: { google: false } });
    expect(readSocialLogin(null)).toEqual({ ios: { apple: false, google: false }, android: { google: false } });
  });

  it("drops iOS Google stored without Apple", () => {
    expect(readSocialLogin({ socialLogin: { ios: { google: true } } }).ios).toEqual({ apple: false, google: false });
  });
});

describe("SocialLoginService", () => {
  it("saves the flags and keeps the brand's other settings", async () => {
    const kp = brand("kp", "Kingston Pizza", { theme: "dark" });
    const { svc } = makeService([kp]);
    const row = await svc.set("kp", { ios: { apple: true, google: true }, android: { google: true } });
    expect(kp.settings).toEqual({
      theme: "dark",
      socialLogin: { ios: { apple: true, google: true }, android: { google: true } },
    });
    expect(row).toMatchObject({ ios: { apple: true, google: true }, appIds: ["com.orderhubsolutions.kingstonpizza"] });
  });

  it("refuses iOS Google without Sign in with Apple", async () => {
    const { svc, prisma } = makeService([brand("kp", "Kingston Pizza")]);
    await expect(
      svc.set("kp", { ios: { apple: false, google: true }, android: { google: false } }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.brand.update).not.toHaveBeenCalled();
  });

  it("allows Apple only on iOS, or Google only on Android", async () => {
    const kp = brand("kp", "Kingston Pizza");
    const { svc } = makeService([kp]);
    await svc.set("kp", { ios: { apple: true, google: false }, android: { google: true } });
    expect((kp.settings as any).socialLogin).toEqual({ ios: { apple: true, google: false }, android: { google: true } });
  });

  it("404s an unknown brand", async () => {
    const { svc } = makeService([]);
    await expect(
      svc.set("nope", { ios: { apple: true, google: false }, android: { google: false } }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it("gives the app everything off for an unknown brand", async () => {
    const { svc } = makeService([]);
    await expect(svc.forApp("nope")).resolves.toEqual({
      ios: { apple: false, google: false },
      android: { google: false },
    });
  });

  it("lists brands with an app or a setting first", async () => {
    const { svc } = makeService([
      brand("a", "Alpha"),
      brand("pu", "Pizza Uno", { socialLogin: { android: { google: true } } }),
      brand("kp", "Kingston Pizza"),
    ]);
    expect((await svc.list()).map((r) => r.brandId)).toEqual(["pu", "kp", "a"]);
  });
});
