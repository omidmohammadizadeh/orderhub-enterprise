import { NotFoundException } from "@nestjs/common";
import {
  DASHBOARD_TABS,
  dashboardTabForPath,
  disabledTabsFromSettings,
  normaliseDisabledTabs,
} from "@orderhub/shared";
import { DashboardAccessService } from "../dashboard-access.service";
import { stripDashboardAccess } from "../../locations/locations.service";

// Admin Dashboard → Dashboard access. The rule under test throughout:
// a tab switched off for a location is invisible to EVERY user there, and
// only a platform admin can switch it back on.

function makePrisma(location: any = makeLocation()) {
  return {
    location: {
      findFirst: jest.fn().mockResolvedValue(location),
      findMany: jest.fn().mockResolvedValue([location]),
      update: jest.fn().mockResolvedValue({}),
    },
    auditLog: { create: jest.fn().mockResolvedValue({}) },
  };
}

function makeLocation(settings: any = {}) {
  return {
    id: "loc-1",
    name: "Dark Kitchen North",
    settings,
    brand: { name: "Pizza Uno" },
  };
}

function service(prisma: any) {
  return new DashboardAccessService(prisma as any);
}

describe("dashboard tab registry", () => {
  it("resolves the most specific tab for a path", () => {
    // /dashboard/orders is a prefix of both — a naive startsWith would make
    // hiding Orders also hide the KDS, and hiding the KDS do nothing.
    expect(dashboardTabForPath("/dashboard/orders/kitchen")?.key).toBe(
      "kitchen-display",
    );
    expect(dashboardTabForPath("/dashboard/orders/cashier")?.key).toBe(
      "cashier",
    );
    expect(dashboardTabForPath("/dashboard/orders")?.key).toBe("orders");
    expect(dashboardTabForPath("/dashboard/orders/abc123")?.key).toBe("orders");
    expect(dashboardTabForPath("/dashboard/marketing/sms")?.key).toBe(
      "marketing-sms",
    );
    expect(dashboardTabForPath("/dashboard/marketing")?.key).toBe("marketing");
  });

  it("claims child routes of a tab", () => {
    expect(dashboardTabForPath("/dashboard/menu/menu-42")?.key).toBe("menu");
    expect(dashboardTabForPath("/dashboard/settings/kitchen")?.key).toBe(
      "kitchen-screens",
    );
  });

  it("owns no admin-only pages", () => {
    // Switching off a page a location's staff can never see would imply a
    // control the picker doesn't have.
    expect(dashboardTabForPath("/dashboard/secrets")).toBeUndefined();
    expect(dashboardTabForPath("/dashboard/admin/dashboard-access")).toBeUndefined();
  });

  it("never lets a similarly-named route be captured", () => {
    // /dashboard/menus would be a different page; prefix matching must stop
    // at a path segment.
    expect(dashboardTabForPath("/dashboard/menus")).toBeUndefined();
  });

  it("uses unique keys and hrefs", () => {
    const keys = DASHBOARD_TABS.map((t) => t.key);
    const hrefs = DASHBOARD_TABS.map((t) => t.href);
    expect(new Set(keys).size).toBe(keys.length);
    expect(new Set(hrefs).size).toBe(hrefs.length);
  });

  describe("normaliseDisabledTabs", () => {
    it("drops unknown keys so a retired route can't keep hiding something", () => {
      expect(normaliseDisabledTabs(["tables", "a-route-we-deleted"])).toEqual([
        "tables",
      ]);
    });

    it("refuses to disable a locked tab", () => {
      // Orders is the redirect target for every disabled page, so hiding it
      // would leave the guard nowhere to send anyone.
      expect(normaliseDisabledTabs(["orders", "tables"])).toEqual(["tables"]);
    });

    it("collapses duplicates and ignores junk", () => {
      expect(
        normaliseDisabledTabs(["tables", "tables", 7, null, { k: 1 }]),
      ).toEqual(["tables"]);
    });

    it("returns an empty list for anything that isn't an array", () => {
      expect(normaliseDisabledTabs(undefined)).toEqual([]);
      expect(normaliseDisabledTabs("tables")).toEqual([]);
      expect(normaliseDisabledTabs({ tables: true })).toEqual([]);
    });
  });

  describe("disabledTabsFromSettings", () => {
    it("reads the admin-owned key", () => {
      expect(
        disabledTabsFromSettings({
          dashboardAccess: { disabledTabs: ["tables", "reservations"] },
        }),
      ).toEqual(["tables", "reservations"]);
    });

    it("treats a location with no setting as fully visible", () => {
      expect(disabledTabsFromSettings({})).toEqual([]);
      expect(disabledTabsFromSettings(null)).toEqual([]);
      expect(disabledTabsFromSettings({ tableService: { enabled: true } })).toEqual(
        [],
      );
    });
  });
});

describe("DashboardAccessService", () => {
  it("scopes the location through its brand, never a tenantId column", async () => {
    // Location has no tenantId of its own — reading one gives undefined,
    // which matches nothing and silently returns every location or none.
    const prisma = makePrisma();
    await service(prisma).get("tenant-a", "loc-1");
    const where = prisma.location.findFirst.mock.calls[0][0].where;
    expect(where).toMatchObject({
      id: "loc-1",
      deletedAt: null,
      brand: { tenantId: "tenant-a" },
    });
    expect(where).not.toHaveProperty("tenantId");
  });

  it("404s for a location outside the tenant", async () => {
    const prisma = makePrisma();
    prisma.location.findFirst.mockResolvedValue(null);
    await expect(service(prisma).get("tenant-b", "loc-1")).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it("saves the disabled list under the admin-owned key", async () => {
    const prisma = makePrisma();
    const row = await service(prisma).set("tenant-a", "loc-1", [
      "tables",
      "reservations",
    ]);
    expect(row.disabledTabs).toEqual(["tables", "reservations"]);
    expect(prisma.location.update.mock.calls[0][0].data.settings).toEqual({
      dashboardAccess: { disabledTabs: ["tables", "reservations"] },
    });
  });

  it("preserves the other tabs' settings when it writes", async () => {
    // settings is one blob shared by the location form, dine-in, POS…
    // Replacing it wholesale would wipe whatever else is in there.
    const prisma = makePrisma(
      makeLocation({ tableService: { enabled: true }, posTileColour: "red" }),
    );
    await service(prisma).set("tenant-a", "loc-1", ["tables"]);
    expect(prisma.location.update.mock.calls[0][0].data.settings).toEqual({
      tableService: { enabled: true },
      posTileColour: "red",
      dashboardAccess: { disabledTabs: ["tables"] },
    });
  });

  it("drops unknown and locked keys instead of rejecting the whole save", async () => {
    // An admin screen one deploy behind must not lose the other twenty
    // toggles over one retired key.
    const prisma = makePrisma();
    const row = await service(prisma).set("tenant-a", "loc-1", [
      "orders",
      "tables",
      "ghost-tab",
    ]);
    expect(row.disabledTabs).toEqual(["tables"]);
  });

  it("clears every restriction when handed an empty list", async () => {
    const prisma = makePrisma(
      makeLocation({ dashboardAccess: { disabledTabs: ["tables"] } }),
    );
    const row = await service(prisma).set("tenant-a", "loc-1", []);
    expect(row.disabledTabs).toEqual([]);
    expect(prisma.location.update.mock.calls[0][0].data.settings).toEqual({
      dashboardAccess: { disabledTabs: [] },
    });
  });

  it("records who changed what", async () => {
    const prisma = makePrisma(
      makeLocation({ dashboardAccess: { disabledTabs: ["tables"] } }),
    );
    await service(prisma).set("tenant-a", "loc-1", ["tables", "kiosk"], {
      userId: "user-9",
      role: "PLATFORM_ADMIN",
    });
    expect(prisma.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          tenantId: "tenant-a",
          userId: "user-9",
          event: "dashboard_access.updated",
          resourceId: "loc-1",
          before: { disabledTabs: ["tables"] },
          after: { disabledTabs: ["tables", "kiosk"] },
        }),
      }),
    );
  });

  it("still saves when the audit write fails", async () => {
    const prisma = makePrisma();
    prisma.auditLog.create.mockRejectedValue(new Error("audit table gone"));
    await expect(
      service(prisma).set("tenant-a", "loc-1", ["tables"]),
    ).resolves.toMatchObject({ disabledTabs: ["tables"] });
    expect(prisma.location.update).toHaveBeenCalled();
  });

  it("lists every location with its current restrictions", async () => {
    const prisma = makePrisma(
      makeLocation({ dashboardAccess: { disabledTabs: ["tables"] } }),
    );
    await expect(service(prisma).list("tenant-a")).resolves.toEqual([
      {
        locationId: "loc-1",
        locationName: "Dark Kitchen North",
        brandName: "Pizza Uno",
        disabledTabs: ["tables"],
      },
    ]);
  });
});

describe("stripDashboardAccess", () => {
  // Hiding the toggles from the location form is not a permission: the same
  // PATCH /locations/:id is one curl away, and an owner who could write this
  // key would just hand themselves back the tab an admin switched off.
  it("removes the key from a non-admin's location PATCH", () => {
    const dto = {
      settings: {
        tableService: { enabled: true },
        dashboardAccess: { disabledTabs: [] },
      },
    };
    expect(stripDashboardAccess(dto, "OWNER").settings).toEqual({
      tableService: { enabled: true },
    });
  });

  it("removes it for an unauthenticated / unknown role too", () => {
    const dto = { settings: { dashboardAccess: { disabledTabs: [] } } };
    expect(stripDashboardAccess(dto, undefined).settings).toEqual({});
  });

  it("lets a platform admin through", () => {
    const dto = { settings: { dashboardAccess: { disabledTabs: ["tables"] } } };
    expect(stripDashboardAccess(dto, "PLATFORM_ADMIN")).toBe(dto);
  });

  it("leaves an ordinary settings patch untouched", () => {
    const dto = { settings: { tableService: { enabled: false } } };
    expect(stripDashboardAccess(dto, "OWNER")).toBe(dto);
  });

  it("leaves a patch with no settings untouched", () => {
    const dto = { name: "Kings Cross" } as any;
    expect(stripDashboardAccess(dto, "OWNER")).toBe(dto);
  });
});
