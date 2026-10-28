import { ForbiddenException } from "@nestjs/common";
import { BrandsService } from "../../modules/brands/brands.service";
import { LocationsService } from "../../modules/locations/locations.service";
import {
  BRAND_MONEY_FIELDS,
  LOCATION_MONEY_FIELDS,
  guardMoneyFields,
} from "./money-fields";

// Payout account + fee fields were hidden in the dashboard but writable by any
// owner through PATCH /brands/:id and PATCH /locations/:id — one request could
// zero OrderHub's fee or send a shop's card money to another Stripe account
// (found 2026-10-28). Only PLATFORM_ADMIN may change them now.

describe("guardMoneyFields", () => {
  const stored = {
    stripeConnectedAccountId: "acct_shop",
    applicationFeeMode: "percentage_only",
    applicationFeeFixedAmount: null,
    applicationFeePercentage: "5.00", // Prisma Decimal comes back as a string-ish value
  };

  it("lets a platform admin change anything", () => {
    const dto: any = { applicationFeePercentage: 0, stripeConnectedAccountId: "acct_other" };
    expect(() => guardMoneyFields(dto, stored, BRAND_MONEY_FIELDS, "PLATFORM_ADMIN")).not.toThrow();
    expect(dto.applicationFeePercentage).toBe(0);
  });

  it.each(["TENANT_OWNER", "OWNER", "MANAGER", undefined])(
    "refuses a %s zeroing the fee",
    (role) => {
      const dto: any = { applicationFeePercentage: 0 };
      expect(() => guardMoneyFields(dto, stored, BRAND_MONEY_FIELDS, role)).toThrow(ForbiddenException);
    },
  );

  it("refuses an owner pointing payouts at another account", () => {
    const dto: any = { stripeConnectedAccountId: "acct_mine" };
    expect(() => guardMoneyFields(dto, stored, BRAND_MONEY_FIELDS, "TENANT_OWNER")).toThrow(
      /stripeConnectedAccountId/,
    );
  });

  it("drops unchanged round-tripped values so an owner's other edits still save", () => {
    const dto: any = {
      name: "New name",
      stripeConnectedAccountId: "acct_shop",
      applicationFeeMode: "percentage_only",
      applicationFeeFixedAmount: "",
      applicationFeePercentage: 5,
    };
    guardMoneyFields(dto, stored, BRAND_MONEY_FIELDS, "TENANT_OWNER");
    expect(dto).toEqual({ name: "New name" });
  });

  it("refuses when nothing is stored to compare against", () => {
    const dto: any = { applicationFeeMode: "none" };
    expect(() => guardMoneyFields(dto, null, BRAND_MONEY_FIELDS, "OWNER")).toThrow(ForbiddenException);
  });
});

describe("BrandsService.update", () => {
  function build(stored: any) {
    const writes: any[] = [];
    const prisma: any = {
      brand: {
        findFirst: async () => ({ id: "b1" }),
        findUnique: async () => stored,
        update: async (args: any) => {
          writes.push(args.data);
          return { id: "b1", ...args.data };
        },
      },
    };
    const svc = new BrandsService(prisma, {} as any, {} as any, {} as any, {} as any, {} as any, {} as any);
    return { svc, writes };
  }

  it("refuses an owner's fee change before anything is written", async () => {
    const { svc, writes } = build({ applicationFeePercentage: "5.00" });
    await expect(
      svc.update("b1", "t1", { applicationFeePercentage: 0 } as any, "TENANT_OWNER"),
    ).rejects.toThrow(ForbiddenException);
    expect(writes).toHaveLength(0);
  });

  it("writes an admin's fee change", async () => {
    const { svc, writes } = build({ applicationFeePercentage: "5.00" });
    await svc.update("b1", "t1", { applicationFeePercentage: 3 } as any, "PLATFORM_ADMIN");
    expect(writes[0].applicationFeePercentage).toBe(3);
  });
});

describe("LocationsService.update", () => {
  it("refuses an owner changing the card-reader fee, checked against the raw row", async () => {
    let updated = false;
    const prisma: any = {
      $queryRawUnsafe: async (sql: string) => {
        expect(sql).toContain('"posTerminalApplicationFeePercent"');
        return [Object.fromEntries(LOCATION_MONEY_FIELDS.map((f) => [f, null]))];
      },
      location: { update: async () => ((updated = true), {}) },
    };
    const svc = new LocationsService(prisma, {} as any, {} as any);
    await expect(
      svc.update("l1", "t1", { posTerminalApplicationFeePercent: 0 } as any, "TENANT_OWNER"),
    ).rejects.toThrow(ForbiddenException);
    expect(updated).toBe(false);
  });
});
