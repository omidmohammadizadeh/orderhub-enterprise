import { ForbiddenException, ExecutionContext } from "@nestjs/common";
import { DeviceLocationGuard } from "../device-location.guard";
import type { AuthenticatedUser } from "../../../modules/auth/interfaces/jwt-payload.interface";

// The device accounts (kiosk tablet, kitchen screen) stay signed in on
// unattended hardware, so the thing worth testing is not "can it reach its own
// page" but "can someone standing at it reach a DIFFERENT branch".

function ctxFor(
  user: Partial<AuthenticatedUser> | null,
  req: { params?: any; query?: any; body?: any } = {},
): ExecutionContext {
  return {
    switchToHttp: () => ({
      getRequest: () => ({
        user: user
          ? { userId: "u1", tenantId: "t1", permissions: [], ...user }
          : undefined,
        params: req.params ?? {},
        query: req.query ?? {},
        body: req.body ?? {},
      }),
    }),
  } as unknown as ExecutionContext;
}

describe("DeviceLocationGuard", () => {
  let prisma: any;
  let guard: DeviceLocationGuard;

  beforeEach(() => {
    prisma = {
      userLocation: { findFirst: jest.fn() },
      kdsScreen: { findFirst: jest.fn() },
    };
    guard = new DeviceLocationGuard(prisma);
  });

  it("ignores real users entirely — a manager is scoped elsewhere", async () => {
    const ctx = ctxFor({ role: "MANAGER" as any }, { query: { locationId: "other" } });
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    expect(prisma.userLocation.findFirst).not.toHaveBeenCalled();
  });

  it("lets a kitchen display reach its own location", async () => {
    prisma.userLocation.findFirst.mockResolvedValue({ id: "ul1" });
    const ctx = ctxFor(
      { role: "KITCHEN_DISPLAY" as any },
      { query: { locationId: "pelton" } },
    );
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    expect(prisma.userLocation.findFirst).toHaveBeenCalledWith({
      where: { userId: "u1", locationId: "pelton" },
      select: { id: true },
    });
  });

  it("blocks a kitchen display asking for another branch", async () => {
    prisma.userLocation.findFirst.mockResolvedValue(null);
    const ctx = ctxFor(
      { role: "KITCHEN_DISPLAY" as any },
      { query: { locationId: "chester" } },
    );
    await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it("blocks a kiosk POSTing an order for another branch", async () => {
    // The body is the shape that matters here: a kiosk creates orders, and the
    // location travels in the payload rather than the URL.
    prisma.userLocation.findFirst.mockResolvedValue(null);
    const ctx = ctxFor(
      { role: "KIOSK" as any },
      { body: { locationId: "chester", items: [] } },
    );
    await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it("resolves a KDS screen id back to its location before deciding", async () => {
    // Most KDS routes name a screen, not a location. If the guard gave up on
    // those, every ticket endpoint would be unprotected.
    prisma.kdsScreen.findFirst.mockResolvedValue({ locationId: "chester" });
    prisma.userLocation.findFirst.mockResolvedValue(null);
    const ctx = ctxFor(
      { role: "KITCHEN_DISPLAY" as any },
      { params: { screenId: "scr1" } },
    );
    await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(prisma.kdsScreen.findFirst).toHaveBeenCalledWith({
      where: { id: "scr1", tenantId: "t1" },
      select: { locationId: true },
    });
  });

  it("passes through when the request names no location", async () => {
    const ctx = ctxFor({ role: "KITCHEN_DISPLAY" as any });
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    expect(prisma.userLocation.findFirst).not.toHaveBeenCalled();
  });

  it("fails closed for a device with no location assigned at all", async () => {
    prisma.userLocation.findFirst.mockResolvedValue(null);
    const ctx = ctxFor(
      { role: "KIOSK" as any },
      { query: { locationId: "pelton" } },
    );
    await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });
});
