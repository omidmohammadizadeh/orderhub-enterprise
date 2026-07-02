import { UnauthorizedException } from "@nestjs/common";
import { TokenService } from "../services/token.service";

// Refresh-token rotation grace window. Two idle tabs waking together both
// present the same refresh token; the loser replays a just-rotated token.
// That used to trip theft detection and revoke EVERY session ("the app
// randomly logs me out"). Replays within the grace window now get a fresh
// pair; replays long after rotation still nuke all sessions (real theft).

const USER = {
  id: "tok-1",
  userId: "user-1",
  revokedAt: null as Date | null,
  expiresAt: new Date(Date.now() + 86400_000),
  user: {
    tenantId: "t-1",
    role: "MANAGER",
    permissions: [],
    isActive: true,
    tenant: {},
  },
};

function setup(stored: any) {
  const prisma = {
    refreshToken: {
      findUnique: jest.fn().mockResolvedValue(stored),
      update: jest.fn().mockResolvedValue({}),
      create: jest.fn().mockResolvedValue({ id: "tok-new" }),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    $transaction: jest
      .fn()
      .mockResolvedValue([{}, { id: "tok-new" }]),
  } as any;
  const jwt = { signAsync: jest.fn().mockResolvedValue("access.jwt") } as any;
  const config = {
    get: (key: string, dflt?: string) =>
      ({ JWT_ACCESS_TTL: "15m", JWT_REFRESH_TTL: "365d" })[key] ?? dflt,
  } as any;
  const svc = new TokenService(jwt, config, prisma);
  return { svc, prisma };
}

const meta = { ipAddress: "1.2.3.4", userAgent: "jest" };

describe("TokenService.rotateTokenPair grace window", () => {
  it("replay within the grace window issues a fresh pair (no session nuke)", async () => {
    const { svc, prisma } = setup({
      ...USER,
      revokedAt: new Date(Date.now() - 5_000), // rotated 5s ago (tab race)
    });
    const out = await svc.rotateTokenPair("raw", meta);
    expect(out.tokens.accessToken).toBe("access.jwt");
    expect(out.tokens.refreshToken).toBeTruthy();
    // No revoke-all
    expect(prisma.refreshToken.updateMany).not.toHaveBeenCalled();
  });

  it("replay AFTER the grace window revokes all sessions (theft)", async () => {
    const { svc, prisma } = setup({
      ...USER,
      revokedAt: new Date(Date.now() - 120_000), // 2 min ago
    });
    await expect(svc.rotateTokenPair("raw", meta)).rejects.toThrow(
      UnauthorizedException,
    );
    expect(prisma.refreshToken.updateMany).toHaveBeenCalled();
  });

  it("normal rotation still works and preserves the original revokedAt on grace replays", async () => {
    const revokedAt = new Date(Date.now() - 5_000);
    const { svc, prisma } = setup({ ...USER, revokedAt });
    await svc.rotateTokenPair("raw", meta);
    // The transaction's update must keep the ORIGINAL revocation timestamp —
    // re-stamping it would make the grace window infinitely renewable.
    const txOps = prisma.$transaction.mock.calls[0][0];
    expect(txOps).toHaveLength(2);
    const updateArg = prisma.refreshToken.update.mock.calls[0]?.[0];
    expect(updateArg.data.revokedAt).toEqual(revokedAt);
  });
});
