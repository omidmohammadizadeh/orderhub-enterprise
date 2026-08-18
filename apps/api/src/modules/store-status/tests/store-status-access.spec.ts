// Who can open Store Status, and what they see when they do.
//
// These are two separate questions and the bug conflated them: OWNER was
// missing from the route's @Roles list, so a location owner was refused by
// the guard and saw an empty tab — not a scoping problem, an ACCESS one.
// The scoping underneath was already correct.

import { ROLES_KEY, TILL_ROLES } from "../../../common/decorators/roles.decorator";
import { StoreStatusController } from "../store-status.controller";

const rolesFor = (method: string): string[] =>
  Reflect.getMetadata(ROLES_KEY, (StoreStatusController.prototype as any)[method]) ?? [];

describe("Store Status — who may open it", () => {
  it("lets a location OWNER through the guard", () => {
    // The reported bug: owners saw no data at all because the guard
    // rejected them before any query ran.
    expect(rolesFor("overview")).toContain("OWNER");
  });

  it("covers BOTH role generations, so they can't drift apart again", () => {
    // Phase AR added OWNER/STAFF/DARK_KITCHEN_MANAGER next to the legacy
    // names. A hand-written list is how OWNER got left out.
    for (const role of TILL_ROLES) {
      expect(rolesFor("overview")).toContain(role);
    }
  });

  it("still excludes roles with no business on the counter", () => {
    const roles = rolesFor("overview");
    for (const role of ["DRIVER", "KIOSK", "VIEWER"]) {
      expect(roles).not.toContain(role);
    }
  });
});

describe("Store Status — what they see once inside", () => {
  const build = () => {
    const getOverview = jest.fn().mockResolvedValue({});
    return { ctrl: new StoreStatusController({ getOverview } as any), getOverview };
  };
  const user = (role: string) =>
    ({ userId: "u1", tenantId: "t1", role, permissions: [] }) as any;

  it("narrows an OWNER to their own locations", () => {
    // Access is not visibility. Passing the userId is what makes the
    // service filter down to that user's UserLocation set — including on
    // "All locations", which has no location filter of its own.
    const { ctrl, getOverview } = build();
    ctrl.overview(user("OWNER"));
    expect(getOverview).toHaveBeenCalledWith("t1", "u1");
  });

  it("narrows STAFF and MANAGER the same way", () => {
    for (const role of ["STAFF", "MANAGER", "CASHIER", "DARK_KITCHEN_MANAGER"]) {
      const { ctrl, getOverview } = build();
      ctrl.overview(user(role));
      expect(getOverview).toHaveBeenCalledWith("t1", "u1");
    }
  });

  it("lets only tenant-wide roles see every location", () => {
    for (const role of ["TENANT_OWNER", "PLATFORM_ADMIN"]) {
      const { ctrl, getOverview } = build();
      ctrl.overview(user(role));
      // undefined userId = no per-user narrowing.
      expect(getOverview).toHaveBeenCalledWith("t1", undefined);
    }
  });
});
