import { UserRole } from "@orderhub/database";
import { TokenService } from "../services/token.service";

// How long an access token lives, per role.
//
// This is not a tuning knob — it is the revocation window. JwtStrategy.validate
// only maps the token's payload; nothing re-reads the database while a token is
// valid. So deactivating a user, changing their role or revoking their refresh
// token does NOT stop them: they keep working until the access token expires.
//
// The till and the dashboard therefore stay at 15 minutes. Drivers are the one
// exception (8h): they work out of signal, every expiry forces a refresh, and a
// refresh attempted in a tunnel used to sign them out of the app mid-delivery.
// A driver token also reaches far less — their own jobs, chat and pings.
//
// If someone widens the non-driver window, these tests should make them say so
// out loud.

function svc(env: Record<string, string> = {}) {
  const config = {
    get: (key: string, fallback?: string) => env[key] ?? fallback,
  };
  const jwt = { signAsync: jest.fn().mockResolvedValue("signed") };
  const s: any = Object.create(TokenService.prototype);
  s.config = config;
  s.jwt = jwt;
  // Mirrors the constructor's parsed values.
  s.accessTtlMs = (s as any).parseTtl.call(s, env.JWT_ACCESS_TTL ?? "15m");
  s.driverAccessTtlMs = (s as any).parseTtl.call(
    s,
    env.JWT_DRIVER_ACCESS_TTL ?? "8h",
  );
  return { s: s as TokenService & Record<string, any>, jwt };
}

const sign = async (role: UserRole, env?: Record<string, string>) => {
  const { s, jwt } = svc(env);
  await (s as any).signAccessToken({
    userId: "u1",
    tenantId: "t1",
    role,
    permissions: [],
  });
  return jwt.signAsync.mock.calls[0][1].expiresIn;
};

describe("access token lifetime by role", () => {
  it("keeps the till and dashboard at 15 minutes", async () => {
    for (const role of [
      UserRole.PLATFORM_ADMIN,
      UserRole.TENANT_OWNER,
      UserRole.MANAGER,
      UserRole.STAFF,
    ]) {
      expect(await sign(role)).toBe("15m");
    }
  });

  it("gives a driver longer, so a tunnel doesn't cost them a refresh", async () => {
    expect(await sign(UserRole.DRIVER)).toBe("8h");
  });

  it("lets both be tuned from the environment", async () => {
    expect(
      await sign(UserRole.DRIVER, { JWT_DRIVER_ACCESS_TTL: "2h" }),
    ).toBe("2h");
    expect(await sign(UserRole.MANAGER, { JWT_ACCESS_TTL: "30m" })).toBe("30m");
    // A driver override must not leak into staff tokens, or the revocation
    // window widens for the till by accident.
    expect(
      await sign(UserRole.MANAGER, { JWT_DRIVER_ACCESS_TTL: "12h" }),
    ).toBe("15m");
  });

  it("tells the client the expiry that matches its own role", async () => {
    const { s } = svc();
    expect((s as any).accessTtlMsFor(UserRole.DRIVER)).toBe(8 * 60 * 60 * 1000);
    expect((s as any).accessTtlMsFor(UserRole.MANAGER)).toBe(15 * 60 * 1000);
  });
});
