import { VoiceContextService } from "../voice-context.service";

// Whose shop is ringing, and which tenant owns the customers.
//
// A Location row has NO tenantId — the tenant lives on its Brand. Reading
// `location.tenantId` therefore yields undefined, and `String(undefined)` is
// the perfectly valid-looking string "undefined". Every caller-ID lookup then
// ran against a tenant that owns nothing, so every caller reached the till as
// "New caller — no order history": a regular of two years with an order in
// the kitchen looked exactly like a stranger.
//
// It failed silently in the one direction nobody checks, which is why these
// tests use a row shaped like the real one rather than a stub that already
// knows the answer.

const SETTINGS = { voiceNumber: "+441632960999", voiceCallerIdOnly: true };

/** A Location as Prisma actually returns it: brand-owned, no tenantId. */
const LOCATION = {
  id: "loc_1",
  phone: "0138 843 6844",
  settings: SETTINGS,
  brand: { tenantId: "tenant_real" },
};

function build(row: any = LOCATION) {
  const findFirst = jest.fn(async () => row);
  const findUnique = jest.fn(async () => row);
  const findMany = jest.fn(async () => (row ? [{ id: row.id, settings: row.settings }] : []));
  const svc: any = Object.create(VoiceContextService.prototype);
  svc.logger = { log() {}, warn() {}, error() {} };
  svc.db = () => ({ location: { findFirst, findUnique, findMany } });
  return { svc, findFirst, findUnique };
}

describe("VoiceContextService.callerIdTarget", () => {
  it("takes the tenant off the BRAND, never off the location row", async () => {
    const { svc } = build();
    const target = await svc.callerIdTarget("+441632960999");
    expect(target.tenantId).toBe("tenant_real");
    // The exact shape of the old bug: a string that is not a tenant but is
    // truthy, so every downstream guard waved it through.
    expect(target.tenantId).not.toBe("undefined");
  });

  it("asks the database for the brand, or the tenant could never be there", async () => {
    const { svc, findFirst } = build();
    await svc.callerIdTarget("+441632960999");
    expect(findFirst.mock.calls[0][0].include).toMatchObject({
      brand: { select: { tenantId: true } },
    });
  });

  it("still identifies the shop and the popup setting", async () => {
    const { svc } = build();
    const target = await svc.callerIdTarget("+441632960999");
    expect(target).toMatchObject({
      locationId: "loc_1",
      callerIdOnly: true,
      locationPhone: "0138 843 6844",
    });
  });

  it("reports no tenant rather than a fake one when the brand is missing", async () => {
    // The caller's number is still worth putting on the till; inventing a
    // tenant to look it up against is not.
    const { svc } = build({ ...LOCATION, brand: undefined });
    const target = await svc.callerIdTarget("+441632960999");
    expect(target.tenantId).toBeNull();
  });

  it("is null when the number is not ours", async () => {
    const { svc } = build(null);
    await expect(svc.callerIdTarget("+441632960000")).resolves.toBeNull();
  });
});
