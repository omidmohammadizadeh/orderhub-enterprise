import "reflect-metadata";
import { plainToInstance } from "class-transformer";
import { validate } from "class-validator";
import { ForbiddenException } from "@nestjs/common";
import {
  normalizeLoginIdentifier,
  tabletEmailFor,
  tabletPasswordProblem,
  tabletUsernameFromEmail,
  TABLET_ANALYTICS_PERMISSION,
} from "../../../common/access/tablet-login";
import { usernameStem } from "../tablet-logins.service";
import { LoginDto } from "../../auth/dto/login.dto";
import { TabletAnalyticsGuard } from "../../analytics/tablet-analytics.guard";
import { TILL_ROLES } from "../../../common/decorators/roles.decorator";

describe("tablet login — existing sign-ins are untouched", () => {
  it("leaves a real email exactly as the old lookup did", () => {
    expect(normalizeLoginIdentifier("  Owner@Shop.com ")).toBe("owner@shop.com");
  });

  it("turns a bare tablet username into its stored address", () => {
    expect(normalizeLoginIdentifier("Monster-Burgerz-High-88681")).toBe(
      tabletEmailFor("monster-burgerz-high-88681"),
    );
    expect(tabletUsernameFromEmail(tabletEmailFor("abc-12345"))).toBe("abc-12345");
  });

  it("LoginDto still rejects junk but accepts emails and usernames", async () => {
    const errs = async (email: unknown) =>
      (await validate(plainToInstance(LoginDto, { email, password: "Passw0rd!" }))).length;
    expect(await errs("owner@shop.com")).toBe(0);
    expect(await errs("monster-burgerz-high-88681")).toBe(0);
    expect(await errs("not an email")).toBeGreaterThan(0);
    expect(await errs("a@")).toBeGreaterThan(0);
    expect(await errs(42)).toBeGreaterThan(0);
  });
});

describe("tablet login — username + password rules", () => {
  it("builds a short stem without repeating the brand", () => {
    expect(usernameStem("Monster Burgerz", "Monster Burgerz - High St")).toBe(
      "monster-burgerz-high-st",
    );
    expect(usernameStem(null, "!!!")).toBe("shop");
    expect(usernameStem("A Very Long Brand Name Indeed", "Somewhere Far").length).toBeLessThanOrEqual(32);
    // Two branches of one brand must still read differently.
    expect(usernameStem("Driver Test Kitchen", "Driver Test Kitchen – Birmingham")).toBe(
      "driver-test-kitchen-birmingham",
    );
  });

  it("matches Uber's reset rule: 8+ chars, a number and a non-digit", () => {
    expect(tabletPasswordProblem("short1")).not.toBeNull();
    expect(tabletPasswordProblem("12345678")).not.toBeNull();
    expect(tabletPasswordProblem("abcdefgh")).not.toBeNull();
    expect(tabletPasswordProblem("abcdefg1")).toBeNull();
  });

  it("is a till role, so the POS works on the tablet", () => {
    expect(TILL_ROLES).toContain("LOCATION_TABLET");
  });
});

describe("TabletAnalyticsGuard", () => {
  const ctx = (role: string, handler: string, query: Record<string, string> = {}) =>
    ({
      switchToHttp: () => ({
        getRequest: () => ({ user: { userId: "u1", tenantId: "t1", role }, query }),
      }),
      getHandler: () => ({ name: handler }),
    }) as any;
  const prisma = (permissions: string[], isActive = true) =>
    ({
      user: { findUnique: jest.fn().mockResolvedValue({ permissions, isActive }) },
      userLocation: { findFirst: jest.fn().mockResolvedValue({ locationId: "own" }) },
    }) as any;

  it("never touches anyone who isn't a tablet", async () => {
    const p = prisma([]);
    for (const role of ["OWNER", "MANAGER", "TENANT_OWNER", "PLATFORM_ADMIN"]) {
      await expect(new TabletAnalyticsGuard(p).canActivate(ctx(role, "getLocationComparison"))).resolves.toBe(true);
    }
    expect(p.user.findUnique).not.toHaveBeenCalled();
  });

  it("blocks the tablet until an owner switches Analytics on", async () => {
    await expect(
      new TabletAnalyticsGuard(prisma([])).canActivate(ctx("LOCATION_TABLET", "getOverview")),
    ).rejects.toBeInstanceOf(ForbiddenException);
    await expect(
      new TabletAnalyticsGuard(prisma([TABLET_ANALYTICS_PERMISSION])).canActivate(
        ctx("LOCATION_TABLET", "getOverview"),
      ),
    ).resolves.toBe(true);
  });

  it("keeps the tablet to its own shop's reports", async () => {
    const on = prisma([TABLET_ANALYTICS_PERMISSION]);
    await expect(
      new TabletAnalyticsGuard(on).canActivate(ctx("LOCATION_TABLET", "getLocationComparison")),
    ).rejects.toBeInstanceOf(ForbiddenException);
    // "All locations" on the page sends no id: pinned to the tablet's own shop.
    const query: Record<string, string> = {};
    const c = ctx("LOCATION_TABLET", "getWalkInReport");
    c.switchToHttp = () => ({
      getRequest: () => ({ user: { userId: "u1", tenantId: "t1", role: "LOCATION_TABLET" }, query }),
    });
    await expect(new TabletAnalyticsGuard(on).canActivate(c)).resolves.toBe(true);
    expect(query.locationId).toBe("own");
    await expect(
      new TabletAnalyticsGuard(on).canActivate(
        ctx("LOCATION_TABLET", "getWalkInReport", { locationId: "loc1" }),
      ),
    ).resolves.toBe(true);
  });
});

describe("TabletShopGuard (tables + reservations)", () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { TabletShopGuard } = require("../../../common/guards/tablet-shop.guard");
  const ctx = (role: string, req: Record<string, any>) =>
    ({
      switchToHttp: () => ({
        getRequest: () => ({
          user: { userId: "u1", tenantId: "t1", role },
          baseUrl: "/api/v1/tables",
          path: "/",
          params: {},
          query: {},
          body: {},
          ...req,
        }),
      }),
    }) as any;
  const prisma = (tableLocation = "mine") =>
    ({
      userLocation: { findMany: jest.fn().mockResolvedValue([{ locationId: "mine" }]) },
      table: {
        findFirst: jest.fn().mockResolvedValue({ locationId: tableLocation }),
        findMany: jest.fn().mockResolvedValue([{ locationId: tableLocation }]),
      },
      tableReservation: { findFirst: jest.fn().mockResolvedValue({ locationId: tableLocation }) },
    }) as any;

  it("never touches staff or owners — even with no location at all", async () => {
    const p = prisma("theirs");
    for (const role of ["STAFF", "MANAGER", "OWNER", "TENANT_OWNER"]) {
      await expect(new TabletShopGuard(p).canActivate(ctx(role, {}))).resolves.toBe(true);
    }
    expect(p.userLocation.findMany).not.toHaveBeenCalled();
  });

  it("makes the tablet name its own shop on a list", async () => {
    await expect(new TabletShopGuard(prisma()).canActivate(ctx("LOCATION_TABLET", {}))).rejects.toBeInstanceOf(ForbiddenException);
    await expect(
      new TabletShopGuard(prisma()).canActivate(ctx("LOCATION_TABLET", { query: { locationId: "mine" } })),
    ).resolves.toBe(true);
  });

  it("refuses another shop's table or booking by id, and moving a tab onto one", async () => {
    await expect(
      new TabletShopGuard(prisma("theirs")).canActivate(ctx("LOCATION_TABLET", { params: { id: "t9" } })),
    ).rejects.toBeInstanceOf(ForbiddenException);
    await expect(
      new TabletShopGuard(prisma("theirs")).canActivate(
        ctx("LOCATION_TABLET", { baseUrl: "/api/v1/reservations", params: { id: "r9" } }),
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
    await expect(
      new TabletShopGuard(prisma("mine")).canActivate(ctx("LOCATION_TABLET", { params: { id: "t1" } })),
    ).resolves.toBe(true);
  });
});
