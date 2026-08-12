import { BadRequestException } from "@nestjs/common";
import * as crypto from "crypto";
import { PasswordResetService } from "../services/password-reset.service";

// A reset link is a temporary key to someone's account. What's tested here is
// mostly what must NOT happen: no telling strangers which emails are
// registered, no raw tokens in the database, no second use of a spent link,
// and no leaving an intruder logged in after the victim resets.

const sha = (t: string) => crypto.createHash("sha256").update(t).digest("hex");

function makeService(over: { prisma?: any; email?: any } = {}) {
  const svc: any = Object.create(PasswordResetService.prototype);
  svc.logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn() };
  svc.prisma = over.prisma;
  svc.email = over.email ?? { send: jest.fn().mockResolvedValue({ id: "e1" }) };
  svc.passwords = { hash: jest.fn().mockResolvedValue("hashed-pw") };
  svc.config = { get: () => "https://www.orderhubsolutions.com" };
  return svc as PasswordResetService & any;
}

function prismaWith(user: any = null, tokenRow: any = null) {
  return {
    user: {
      findUnique: jest.fn().mockResolvedValue(user),
      update: jest.fn().mockResolvedValue({}),
    },
    passwordResetToken: {
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      create: jest.fn().mockResolvedValue({}),
      findUnique: jest.fn().mockResolvedValue(tokenRow),
      update: jest.fn().mockResolvedValue({}),
    },
    refreshToken: { updateMany: jest.fn().mockResolvedValue({ count: 0 }) },
    $transaction: jest.fn().mockResolvedValue([]),
  };
}

const ACTIVE_USER = {
  id: "u1",
  email: "omid@orderhubpos.com",
  firstName: "Omid",
  isActive: true,
};

describe("PasswordResetService — requesting a link", () => {
  it("emails a link to a real account", async () => {
    const prisma = prismaWith(ACTIVE_USER);
    const email = { send: jest.fn().mockResolvedValue({ id: "e1" }) };
    const svc = makeService({ prisma, email });

    await svc.request("omid@orderhubpos.com");

    expect(email.send).toHaveBeenCalledTimes(1);
    const sent = email.send.mock.calls[0][0];
    expect(sent.to).toBe("omid@orderhubpos.com");
    expect(sent.html).toContain("/reset-password?token=");
  });

  it("says nothing and sends nothing for an unknown address", async () => {
    // No throw, no different return — the caller must not be able to tell.
    const prisma = prismaWith(null);
    const email = { send: jest.fn() };
    const svc = makeService({ prisma, email });

    await expect(svc.request("nobody@example.com")).resolves.toBeUndefined();
    expect(email.send).not.toHaveBeenCalled();
  });

  it("won't send to a deactivated account", async () => {
    const prisma = prismaWith({ ...ACTIVE_USER, isActive: false });
    const email = { send: jest.fn() };
    const svc = makeService({ prisma, email });

    await svc.request("omid@orderhubpos.com");

    expect(email.send).not.toHaveBeenCalled();
  });

  it("stores only the hash — the emailed token is never written down", async () => {
    const prisma = prismaWith(ACTIVE_USER);
    const email = { send: jest.fn().mockResolvedValue({ id: "e1" }) };
    const svc = makeService({ prisma, email });

    await svc.request("omid@orderhubpos.com");

    const stored = prisma.passwordResetToken.create.mock.calls[0][0].data;
    const link: string = email.send.mock.calls[0][0].html;
    const token = decodeURIComponent(
      link.split("/reset-password?token=")[1].split(/["&]/)[0],
    );

    expect(stored.tokenHash).toBe(sha(token));
    expect(stored.tokenHash).not.toBe(token);
    expect(JSON.stringify(stored)).not.toContain(token);
  });

  it("voids any earlier outstanding link for that user", async () => {
    const prisma = prismaWith(ACTIVE_USER);
    const svc = makeService({ prisma });

    await svc.request("omid@orderhubpos.com");

    expect(prisma.passwordResetToken.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId: "u1", usedAt: null },
      }),
    );
  });

  it("stays silent when the email provider fails", async () => {
    // A failure that only ever happens for real addresses is itself a way to
    // tell real addresses apart.
    const prisma = prismaWith(ACTIVE_USER);
    const email = { send: jest.fn().mockRejectedValue(new Error("smtp down")) };
    const svc = makeService({ prisma, email });

    await expect(svc.request("omid@orderhubpos.com")).resolves.toBeUndefined();
  });

  it("lowercases the address so a capitalised email still finds the account", async () => {
    const prisma = prismaWith(ACTIVE_USER);
    const svc = makeService({ prisma });

    await svc.request("  Omid@OrderHubPos.com ");

    expect(prisma.user.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { email: "omid@orderhubpos.com" } }),
    );
  });
});

describe("PasswordResetService — spending a link", () => {
  const future = () => new Date(Date.now() + 30 * 60_000);
  const past = () => new Date(Date.now() - 60_000);

  it("sets the new password and ends every other session", async () => {
    // Someone resetting usually believes another person is in their account.
    // A new password that leaves that person signed in is worse than useless.
    const prisma = prismaWith(null, {
      id: "t1",
      userId: "u1",
      usedAt: null,
      expiresAt: future(),
    });
    const svc = makeService({ prisma });

    await svc.reset("tok", "a-good-password");

    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(prisma.user.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "u1" },
        data: { password: "hashed-pw" },
      }),
    );
    expect(prisma.refreshToken.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId: "u1", revokedAt: null },
      }),
    );
  });

  it("marks the link spent in the same transaction as the password write", async () => {
    const prisma = prismaWith(null, {
      id: "t1",
      userId: "u1",
      usedAt: null,
      expiresAt: future(),
    });
    const svc = makeService({ prisma });

    await svc.reset("tok", "a-good-password");

    expect(prisma.passwordResetToken.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "t1" } }),
    );
    // All three writes go in as one unit — a crash between them must not
    // leave a live link on an already-changed password.
    expect(prisma.$transaction.mock.calls[0][0]).toHaveLength(3);
  });

  it("refuses a link that has already been used", async () => {
    const prisma = prismaWith(null, {
      id: "t1",
      userId: "u1",
      usedAt: new Date(),
      expiresAt: future(),
    });
    const svc = makeService({ prisma });

    await expect(svc.reset("tok", "a-good-password")).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it("refuses an expired link", async () => {
    const prisma = prismaWith(null, {
      id: "t1",
      userId: "u1",
      usedAt: null,
      expiresAt: past(),
    });
    const svc = makeService({ prisma });

    await expect(svc.reset("tok", "a-good-password")).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it("gives the same message for missing, spent and expired links", async () => {
    // Telling them apart tells whoever holds a stolen link which kind of
    // wrong it is, and whether it was ever real.
    const messages: string[] = [];
    for (const row of [
      null,
      { id: "t1", userId: "u1", usedAt: new Date(), expiresAt: future() },
      { id: "t1", userId: "u1", usedAt: null, expiresAt: past() },
    ]) {
      const svc = makeService({ prisma: prismaWith(null, row) });
      await svc.reset("tok", "a-good-password").catch((e: any) => {
        messages.push(e.message);
      });
    }
    expect(messages).toHaveLength(3);
    expect(new Set(messages).size).toBe(1);
  });

  it("rejects a too-short password before touching the token", async () => {
    const prisma = prismaWith(null, {
      id: "t1",
      userId: "u1",
      usedAt: null,
      expiresAt: future(),
    });
    const svc = makeService({ prisma });

    await expect(svc.reset("tok", "short")).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(prisma.passwordResetToken.findUnique).not.toHaveBeenCalled();
  });

  it("looks the token up by hash, never by its raw value", async () => {
    const prisma = prismaWith(null, {
      id: "t1",
      userId: "u1",
      usedAt: null,
      expiresAt: future(),
    });
    const svc = makeService({ prisma });

    await svc.reset("my-secret-token", "a-good-password");

    expect(prisma.passwordResetToken.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { tokenHash: sha("my-secret-token") },
      }),
    );
  });
});

describe("PasswordResetService — checking a link", () => {
  it("reports a fresh link as usable", async () => {
    const svc = makeService({
      prisma: prismaWith(null, {
        usedAt: null,
        expiresAt: new Date(Date.now() + 60_000),
      }),
    });
    await expect(svc.check("tok")).resolves.toEqual({ valid: true });
  });

  it("reports spent and expired links as unusable", async () => {
    const spent = makeService({
      prisma: prismaWith(null, {
        usedAt: new Date(),
        expiresAt: new Date(Date.now() + 60_000),
      }),
    });
    const expired = makeService({
      prisma: prismaWith(null, {
        usedAt: null,
        expiresAt: new Date(Date.now() - 60_000),
      }),
    });
    const missing = makeService({ prisma: prismaWith(null, null) });

    await expect(spent.check("t")).resolves.toEqual({ valid: false });
    await expect(expired.check("t")).resolves.toEqual({ valid: false });
    await expect(missing.check("t")).resolves.toEqual({ valid: false });
  });
});
