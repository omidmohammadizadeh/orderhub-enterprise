import { ForbiddenException, ExecutionContext } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { RolesGuard } from "../../../common/guards/roles.guard";
import { ROLES_KEY, PERMISSIONS_KEY } from "../../../common/decorators/roles.decorator";
import type { AuthenticatedUser } from "../interfaces/jwt-payload.interface";

function makeContext(user: AuthenticatedUser | null, roles?: string[], perms?: string[]): ExecutionContext {
  return {
    getHandler: () => ({}),
    getClass: () => ({}),
    switchToHttp: () => ({
      getRequest: () => ({ user }),
    }),
  } as unknown as ExecutionContext;
}

describe("RolesGuard", () => {
  let guard: RolesGuard;
  let reflector: jest.Mocked<Reflector>;

  const baseUser = (role: AuthenticatedUser["role"]): AuthenticatedUser => ({
    userId: "u1",
    tenantId: "t1",
    role,
    permissions: [],
  });

  beforeEach(() => {
    reflector = {
      getAllAndOverride: jest.fn(),
    } as unknown as jest.Mocked<Reflector>;

    guard = new RolesGuard(reflector);
  });

  it("allows when no roles or permissions are required", () => {
    reflector.getAllAndOverride.mockReturnValue(undefined);
    const ctx = makeContext(baseUser("VIEWER"));
    expect(guard.canActivate(ctx)).toBe(true);
  });

  it("PLATFORM_ADMIN bypasses all role checks", () => {
    reflector.getAllAndOverride
      .mockReturnValueOnce(["TENANT_OWNER"]) // ROLES_KEY
      .mockReturnValueOnce(undefined);       // PERMISSIONS_KEY

    const ctx = makeContext(baseUser("PLATFORM_ADMIN"));
    expect(guard.canActivate(ctx)).toBe(true);
  });

  it("TENANT_OWNER passes a MANAGER-required route (hierarchy)", () => {
    reflector.getAllAndOverride
      .mockReturnValueOnce(["MANAGER"])
      .mockReturnValueOnce(undefined);

    const ctx = makeContext(baseUser("TENANT_OWNER"));
    expect(guard.canActivate(ctx)).toBe(true);
  });

  it("VIEWER fails a MANAGER-required route", () => {
    reflector.getAllAndOverride
      .mockReturnValueOnce(["MANAGER"])
      .mockReturnValueOnce(undefined);

    const ctx = makeContext(baseUser("VIEWER"));
    expect(() => guard.canActivate(ctx)).toThrow(ForbiddenException);
  });

  // OWNER sits OUTSIDE the rank hierarchy, so it can only pass by exact match.
  it("OWNER passes a route that explicitly lists OWNER", () => {
    reflector.getAllAndOverride
      .mockReturnValueOnce(["OWNER", "TENANT_OWNER", "PLATFORM_ADMIN"])
      .mockReturnValueOnce(undefined);

    const ctx = makeContext(baseUser("OWNER" as AuthenticatedUser["role"]));
    expect(guard.canActivate(ctx)).toBe(true);
  });

  // Regression: listing a non-hierarchy role used to make indexOf === -1 the
  // minimum rank, which let EVERY authenticated user through.
  it("listing OWNER does not open the route to VIEWER", () => {
    reflector.getAllAndOverride
      .mockReturnValueOnce(["OWNER", "TENANT_OWNER", "PLATFORM_ADMIN"])
      .mockReturnValueOnce(undefined);

    const ctx = makeContext(baseUser("VIEWER"));
    expect(() => guard.canActivate(ctx)).toThrow(ForbiddenException);
  });

  it("OWNER still fails a route that doesn't list it", () => {
    reflector.getAllAndOverride
      .mockReturnValueOnce(["MANAGER", "TENANT_OWNER"])
      .mockReturnValueOnce(undefined);

    const ctx = makeContext(baseUser("OWNER" as AuthenticatedUser["role"]));
    expect(() => guard.canActivate(ctx)).toThrow(ForbiddenException);
  });

  it("throws ForbiddenException when not authenticated", () => {
    reflector.getAllAndOverride
      .mockReturnValueOnce(["VIEWER"])
      .mockReturnValueOnce(undefined);

    const ctx = makeContext(null);
    expect(() => guard.canActivate(ctx)).toThrow(ForbiddenException);
  });

  it("passes permission check when user has required permission via role", () => {
    reflector.getAllAndOverride
      .mockReturnValueOnce(undefined)           // ROLES_KEY
      .mockReturnValueOnce(["orders:read"]);    // PERMISSIONS_KEY

    // MANAGER has orders:read by default
    const ctx = makeContext(baseUser("MANAGER"));
    expect(guard.canActivate(ctx)).toBe(true);
  });

  it("fails permission check when user lacks the permission", () => {
    reflector.getAllAndOverride
      .mockReturnValueOnce(undefined)
      .mockReturnValueOnce(["billing:manage"]);

    // CASHIER does not have billing:manage
    const ctx = makeContext(baseUser("CASHIER"));
    expect(() => guard.canActivate(ctx)).toThrow(ForbiddenException);
  });

  it("passes permission check when user has permission via personal override", () => {
    reflector.getAllAndOverride
      .mockReturnValueOnce(undefined)
      .mockReturnValueOnce(["billing:manage"]);

    const ctx = makeContext({
      ...baseUser("CASHIER"),
      permissions: ["billing:manage"], // Personal override
    });
    expect(guard.canActivate(ctx)).toBe(true);
  });

  // ── Device accounts ──────────────────────────────────────────────────────
  // KIOSK and KITCHEN_DISPLAY sit OUTSIDE the hierarchy on purpose. If either
  // ever gained a rank, granting a route to a low role would silently hand it
  // to a wall-mounted screen as well.

  it("does not let a kitchen display inherit a route granted to KITCHEN_STAFF", () => {
    reflector.getAllAndOverride.mockReturnValueOnce(["KITCHEN_STAFF"]);
    const ctx = makeContext(baseUser("KITCHEN_DISPLAY" as any));
    expect(() => guard.canActivate(ctx)).toThrow(ForbiddenException);
  });

  it("does not let a kiosk inherit a route granted to STAFF or CASHIER", () => {
    reflector.getAllAndOverride.mockReturnValueOnce(["CASHIER", "STAFF"]);
    const ctx = makeContext(baseUser("KIOSK" as any));
    expect(() => guard.canActivate(ctx)).toThrow(ForbiddenException);
  });

  it("admits a device only where its role is named outright", () => {
    reflector.getAllAndOverride.mockReturnValueOnce([
      "KITCHEN_DISPLAY",
      "KITCHEN_STAFF",
    ]);
    const ctx = makeContext(baseUser("KITCHEN_DISPLAY" as any));
    expect(guard.canActivate(ctx)).toBe(true);
  });
});
