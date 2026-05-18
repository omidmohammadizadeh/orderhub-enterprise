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
});
