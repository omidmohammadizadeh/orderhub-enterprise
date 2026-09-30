import { JetGoConfigService } from "../jet-go-config.service";

// JET Go keeps ONE notification config per client credential. So two locations
// that paste the same clientId cannot have their own webhook URLs — registering
// the second would repoint JET away from the first and silently strand that
// shop's courier updates. upsert() therefore reuses a sibling's token.

type Row = Record<string, any>;

function svcWith(rows: Row[]) {
  const prisma: any = {
    location: { findFirst: jest.fn(async () => ({ id: "loc1" })) },
    jetGoConfig: {
      findUnique: jest.fn(async ({ where }: any) =>
        rows.find((r) => r.locationId === where.locationId) ?? null,
      ),
      findMany: jest.fn(async ({ where }: any) =>
        rows.filter(
          (r) =>
            (where?.tenantId === undefined || r.tenantId === where.tenantId) &&
            (where?.NOT?.locationId === undefined || r.locationId !== where.NOT.locationId) &&
            (where?.webhookToken === undefined || r.webhookToken === where.webhookToken),
        ),
      ),
      upsert: jest.fn(async ({ where, create, update }: any) => {
        const found = rows.find((r) => r.locationId === where.locationId);
        if (found) Object.assign(found, update);
        else rows.push({ ...create });
        return {};
      }),
      update: jest.fn(async ({ where, data }: any) => {
        const found = rows.find((r) => r.locationId === where.locationId);
        if (found) Object.assign(found, data);
        return {};
      }),
    },
  };
  // Plaintext stand-in for the real AES-GCM envelope.
  const encryption: any = {
    encrypt: (v: any) => ({ plain: v }),
    decrypt: (v: any) => v?.plain ?? {},
  };
  const s: any = Object.create(JetGoConfigService.prototype);
  s.prisma = prisma;
  s.encryption = encryption;
  return { s: s as JetGoConfigService, rows };
}

const row = (over: Row = {}): Row => ({
  id: "c1",
  tenantId: "t1",
  locationId: "locA",
  market: "UK",
  environment: "sandbox",
  credentials: { plain: { clientId: "shared-id", clientSecret: "s" } },
  collectPointId: "cp-a",
  collectPointName: "Shop A",
  webhookToken: "token-shared",
  webhookSecret: "secret-shared",
  active: true,
  ...over,
});

describe("webhook token sharing", () => {
  it("reuses a sibling location's token AND secret when the clientId matches", async () => {
    const { s, rows } = svcWith([row()]);
    await s.upsert("locB", "t1", { clientId: "shared-id", clientSecret: "s2" });
    const b = rows.find((r) => r.locationId === "locB")!;
    expect(b.webhookToken).toBe("token-shared");
    expect(b.webhookSecret).toBe("secret-shared");
  });

  it("gives the path token and the auth secret different values", async () => {
    // The URL is shown to the operator and pasted around. If the path segment
    // were also the credential, seeing the URL would be enough to forge courier
    // updates.
    const { s, rows } = svcWith([]);
    await s.upsert("locB", "t1", { clientId: "x", clientSecret: "y" });
    const r = rows[0]!;
    expect(r.webhookToken).toBeTruthy();
    expect(r.webhookSecret).toBeTruthy();
    expect(r.webhookSecret).not.toBe(r.webhookToken);
  });

  it("mints a secret for a row created before webhookSecret existed", async () => {
    const { s, rows } = svcWith([row({ locationId: "locA", webhookSecret: "" })]);
    await s.upsert("locA", "t1", { clientId: "shared-id", clientSecret: "s" });
    expect(rows[0]!.webhookSecret).toBeTruthy();
    // The already-registered URL must not change underneath JET.
    expect(rows[0]!.webhookToken).toBe("token-shared");
  });

  it("mints a fresh token for a different clientId", async () => {
    const { s, rows } = svcWith([row()]);
    await s.upsert("locB", "t1", { clientId: "other-id", clientSecret: "s2" });
    const t = rows.find((r) => r.locationId === "locB")!.webhookToken;
    expect(t).toBeTruthy();
    expect(t).not.toBe("token-shared");
  });

  it("keeps a location's existing token when its credentials are re-saved", async () => {
    // Rotating a secret must not invalidate the webhook URL already registered
    // with JET.
    const { s, rows } = svcWith([row({ locationId: "locA" })]);
    await s.upsert("locA", "t1", { clientId: "shared-id", clientSecret: "rotated" });
    expect(rows[0]!.webhookToken).toBe("token-shared");
  });

  it("does not borrow a token across tenants", async () => {
    const { s, rows } = svcWith([row({ tenantId: "other-tenant" })]);
    await s.upsert("locB", "t1", { clientId: "shared-id", clientSecret: "s" });
    expect(rows.find((r) => r.locationId === "locB")!.webhookToken).not.toBe("token-shared");
  });

  it("survives a sibling row whose credentials won't decrypt", async () => {
    const { s, rows } = svcWith([row()]);
    (s as any).encryption.decrypt = (v: any) => {
      if (v?.plain?.clientId === "shared-id") throw new Error("bad key");
      return v?.plain ?? {};
    };
    await s.upsert("locB", "t1", { clientId: "shared-id", clientSecret: "s" });
    expect(rows.find((r) => r.locationId === "locB")!.webhookToken).toBeTruthy();
  });
});

describe("validation", () => {
  it("requires both halves of the credential", async () => {
    const { s } = svcWith([]);
    await expect(s.upsert("locB", "t1", { clientId: " ", clientSecret: "s" })).rejects.toThrow(
      /required/i,
    );
    await expect(s.upsert("locB", "t1", { clientId: "x", clientSecret: "" })).rejects.toThrow(
      /required/i,
    );
  });

  it("defaults an unrecognised market to UK rather than an invalid host", async () => {
    const { s, rows } = svcWith([]);
    await s.upsert("locB", "t1", { clientId: "x", clientSecret: "y", market: "MARS" });
    expect(rows[0]!.market).toBe("UK");
  });

  it("only accepts 'production' as production", async () => {
    const { s, rows } = svcWith([]);
    await s.upsert("locB", "t1", { clientId: "x", clientSecret: "y", environment: "live" });
    expect(rows[0]!.environment).toBe("sandbox");
  });

  it("refuses to activate without a collect point, which dispatch can't work without", async () => {
    const { s } = svcWith([row({ locationId: "locB", collectPointId: null, active: false })]);
    await expect(s.setActive("locB", "t1", true)).rejects.toThrow(/collect point/i);
  });

  it("allows activating once a collect point is chosen", async () => {
    const { s, rows } = svcWith([row({ locationId: "locB", collectPointId: null, active: false })]);
    await s.setCollectPoint("locB", "t1", "cp-b", "Shop B");
    await s.setActive("locB", "t1", true);
    expect(rows[0]!.active).toBe(true);
    expect(rows[0]!.collectPointId).toBe("cp-b");
  });

  it("refuses a collect point before any credentials exist", async () => {
    const { s } = svcWith([]);
    await expect(s.setCollectPoint("locB", "t1", "cp-b")).rejects.toThrow(/credentials/i);
  });
});

describe("the operator view", () => {
  it("masks the client id and never returns either secret", async () => {
    const { s } = svcWith([
      row({ credentials: { plain: { clientId: "abcdefgh1234", clientSecret: "topsecret" } } }),
    ]);
    const pub: any = await s.getPublicConfig("locA", "t1", "https://api.test/");
    expect(pub.clientIdMasked).toBe("abcd…1234");
    expect(JSON.stringify(pub)).not.toContain("topsecret");
    // The webhook AUTH secret must never reach the browser. The path token does,
    // inside the URL, which is what it is for.
    expect(JSON.stringify(pub)).not.toContain("secret-shared");
  });

  it("builds the webhook URL off the token, not the location", async () => {
    const { s } = svcWith([row()]);
    const pub: any = await s.getPublicConfig("locA", "t1", "https://api.test/");
    expect(pub.webhookUrl).toBe("https://api.test/api/v1/webhooks/jet-go/token-shared");
  });

  it("is only readyToDispatch with credentials, a collect point AND active", async () => {
    const mk = async (over: Row) => {
      const { s } = svcWith([row(over)]);
      return (await s.getPublicConfig("locA", "t1", "https://api.test")) as any;
    };
    expect((await mk({})).readyToDispatch).toBe(true);
    expect((await mk({ active: false })).readyToDispatch).toBe(false);
    expect((await mk({ collectPointId: null })).readyToDispatch).toBe(false);
  });

  it("reports an unconfigured location without inventing a webhook URL", async () => {
    const { s } = svcWith([]);
    const pub: any = await s.getPublicConfig("locA", "t1", "https://api.test");
    expect(pub).toMatchObject({ configured: false, readyToDispatch: false, webhookUrl: null });
  });
});
