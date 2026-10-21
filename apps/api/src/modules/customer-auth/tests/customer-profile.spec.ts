import { BadRequestException } from "@nestjs/common";
import { CustomerAuthService } from "../customer-auth.service";

// Two things a customer's sign-in and profile now depend on:
//
//  1. Where Google sign-in and the confirmation email send them back. A
//     brand's own domain has its own localStorage — returning a customer to
//     orderhubsolutions.com instead lost their basket. But only origins we
//     serve may be returned to, or the callback is an open redirect.
//  2. The saved details on their account: partial updates, null clears, and a
//     date of birth that is a real date.

function makeService(customDomains: string[] = ["thegrillshack.co.uk"]) {
  const updates: any[] = [];
  const prisma = {
    brand: {
      findFirst: jest.fn(async (args: any) => {
        const wanted: string[] = args.where.customDomain.in;
        return customDomains.some((d) => wanted.includes(d)) ? { id: "b1" } : null;
      }),
    },
    customerAccount: {
      update: jest.fn(async (args: any) => {
        updates.push(args.data);
        return { id: "c1", email: "a@b.c", firstName: "A", lastName: "B", ...args.data };
      }),
    },
  } as any;
  const svc = new CustomerAuthService(prisma, {} as any, {} as any, {} as any, {
    get: () => "",
  } as any);
  return { svc, prisma, updates };
}

describe("trustedStorefrontOrigin", () => {
  it("accepts our own sites", async () => {
    const { svc } = makeService();
    await expect(svc.trustedStorefrontOrigin("https://www.orderhubsolutions.com")).resolves.toBe(
      "https://www.orderhubsolutions.com",
    );
  });

  it("accepts a brand's custom domain, with or without www", async () => {
    const { svc } = makeService();
    await expect(svc.trustedStorefrontOrigin("https://thegrillshack.co.uk")).resolves.toBe(
      "https://thegrillshack.co.uk",
    );
    await expect(svc.trustedStorefrontOrigin("https://www.thegrillshack.co.uk")).resolves.toBe(
      "https://www.thegrillshack.co.uk",
    );
  });

  it("refuses anything else — no open redirect", async () => {
    const { svc } = makeService();
    for (const bad of [
      "https://evil.example",
      "http://thegrillshack.co.uk", // brand domains are https only
      "https://thegrillshack.co.uk/steal?x=1", // origin only, no path
      "https://user:pw@thegrillshack.co.uk",
      "javascript:alert(1)",
      "",
      undefined,
    ]) {
      await expect(svc.trustedStorefrontOrigin(bad)).resolves.toBeNull();
    }
  });
});

describe("updateProfile", () => {
  it("writes only the fields sent, trims, and upper-cases the postcode", async () => {
    const { svc, updates } = makeService();
    const out = await svc.updateProfile("c1", {
      phone: " 07700 900123 ",
      addressPostcode: "po9 1aa",
    });
    expect(updates[0]).toEqual({ phone: "07700 900123", addressPostcode: "PO9 1AA" });
    expect(out.addressPostcode).toBe("PO9 1AA");
  });

  it("null or blank clears an optional field", async () => {
    const { svc, updates } = makeService();
    await svc.updateProfile("c1", { addressLine2: null, addressCity: "  " });
    expect(updates[0]).toEqual({ addressLine2: null, addressCity: null });
  });

  it("stores a date of birth and returns it as YYYY-MM-DD", async () => {
    const { svc, updates } = makeService();
    const out = await svc.updateProfile("c1", { dateOfBirth: "1990-04-23" });
    expect(updates[0].dateOfBirth).toEqual(new Date("1990-04-23T00:00:00.000Z"));
    expect(out.dateOfBirth).toBe("1990-04-23");
  });

  it("refuses dates that don't exist, are in the future, or are before 1900", async () => {
    const { svc } = makeService();
    for (const bad of ["2001-02-30", "2999-01-01", "1850-06-01"]) {
      await expect(svc.updateProfile("c1", { dateOfBirth: bad })).rejects.toBeInstanceOf(
        BadRequestException,
      );
    }
  });
});
