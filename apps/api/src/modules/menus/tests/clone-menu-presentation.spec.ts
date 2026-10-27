import { NotFoundException } from "@nestjs/common";
import { MenusService } from "../menus.service";

// A CLONED MENU SHOULD LOOK LIKE THE ONE IT CAME FROM.
//
// "kingston pizza shop" carries a banner image. Cloning it produced a menu with
// no banner at all, because the clone only ever copied brand, location, name,
// status and menuType — the storefront images and the description were dropped
// on the floor and had to be set again by hand.
//
// Also copied now: `pricingVariants`. The per-item `platformPricingOverrides`
// already came across with the deep-copied products, so without the menu-level
// variant list the clone held channel prices whose variant nothing could name:
// the pricing modal showed none of them, and `buildPriceMap` resolved
// `variants.find(v => v.ref === ref)?.brandId` to null, quietly dropping a
// variant's brand RESTRICTION so a publish could include items it was meant to
// leave out.
//
// What a clone must NOT inherit is anything about having been published:
// status stays DRAFT, and the auto-publish schedule is left off — a copy that
// inherited a schedule would publish itself on the original's timetable.

const TENANT = "t1";

const SOURCE: any = {
  id: "m-source",
  brandId: "b1",
  locationId: "loc-1",
  name: "kingston pizza shop",
  description: "Stone-baked pizzas and kebabs",
  menuType: "DELIVERY_AND_PICKUP",
  bannerImage: "https://cdn.example.com/banner.jpg",
  heroImage: "https://cdn.example.com/hero.jpg",
  logoImage: "https://cdn.example.com/logo.png",
  status: "PUBLISHED",
  publishedTo: ["JUST_EAT", "DELIVEROO"],
  lastPublishedAt: new Date("2026-10-04T21:54:20.067Z"),
  autoScheduleEnabled: true,
  autoSchedule: { days: [4], time: "16:45" },
  pricingVariants: [
    { ref: "b1__JUST_EAT", channelKey: "JUST_EAT", name: "Kingston — Just Eat", brandId: "b1" },
  ],
  categories: [],
};

function harness() {
  const created: any[] = [];
  const tx: any = {
    menu: { create: async ({ data }: any) => { const r = { id: "m-clone", ...data }; created.push(r); return r; } },
    menuCategory: { create: async ({ data }: any) => ({ id: "c1", ...data }) },
    menuItemOnCategory: { create: async ({ data }: any) => data },
    menuItem: { create: async ({ data }: any) => ({ id: "i1", ...data }) },
    modifierGroup: { create: async ({ data }: any) => ({ id: "g1", ...data }), findFirst: async () => null },
    modifierOption: { findMany: async () => [], create: async ({ data }: any) => ({ id: "o1", ...data }) },
    modifierOptionNestedGroup: { findMany: async () => [], create: async ({ data }: any) => data },
    modifierGroupOnItem: { create: async ({ data }: any) => data },
  };
  const prisma: any = { $transaction: async (fn: any) => fn(tx) };
  const svc = new MenusService(prisma, {} as any, {} as any, {} as any, {} as any, {} as any, {} as any, {} as any);
  (svc as any).findOne = async (id: string, tenantId: string) => {
    if (tenantId !== TENANT || id !== SOURCE.id) throw new NotFoundException("Menu not found");
    return SOURCE;
  };
  (svc as any).seedUsedPlus = async () => {};
  return { svc, created };
}

describe("MenusService.clone — the copy carries the original's presentation", () => {
  it("copies the banner image", async () => {
    const { svc, created } = harness();

    await svc.clone("m-source", TENANT, "kingston pizza shop (copy)");

    expect(created[0].bannerImage).toBe("https://cdn.example.com/banner.jpg");
  });

  it("copies the hero and logo images too", async () => {
    const { svc, created } = harness();

    await svc.clone("m-source", TENANT, "copy");

    expect(created[0].heroImage).toBe("https://cdn.example.com/hero.jpg");
    expect(created[0].logoImage).toBe("https://cdn.example.com/logo.png");
  });

  it("copies the description", async () => {
    const { svc, created } = harness();

    await svc.clone("m-source", TENANT, "copy");

    expect(created[0].description).toBe("Stone-baked pizzas and kebabs");
  });

  it("copies the pricing variants, which the item overrides depend on", async () => {
    const { svc, created } = harness();

    await svc.clone("m-source", TENANT, "copy");

    expect(created[0].pricingVariants).toEqual(SOURCE.pricingVariants);
  });

  it("keeps the name it was given, not the original's", async () => {
    const { svc, created } = harness();

    await svc.clone("m-source", TENANT, "kingston pizza shop (copy)");

    expect(created[0].name).toBe("kingston pizza shop (copy)");
  });

  it("starts as an unpublished DRAFT however published the original was", async () => {
    const { svc, created } = harness();

    await svc.clone("m-source", TENANT, "copy");

    expect(created[0].status).toBe("DRAFT");
    expect(created[0].publishedTo).toBeUndefined();
    expect(created[0].lastPublishedAt).toBeUndefined();
  });

  it("never inherits the auto-publish schedule", async () => {
    // A copy that did would publish itself on the original's timetable —
    // a draft going live on its own is worse than a missing banner.
    const { svc, created } = harness();

    await svc.clone("m-source", TENANT, "copy");

    expect(created[0].autoScheduleEnabled).toBeUndefined();
    expect(created[0].autoSchedule).toBeUndefined();
  });

  it("still honours a cross-location clone", async () => {
    const { svc, created } = harness();
    (svc as any).prisma = {
      ...(svc as any).prisma,
      location: { findFirst: async () => ({ id: "loc-2" }) },
    };

    await svc.clone("m-source", TENANT, "copy", { targetLocationId: "loc-2" });

    expect(created[0].locationId).toBe("loc-2");
    expect(created[0].bannerImage).toBe("https://cdn.example.com/banner.jpg");
  });
});
