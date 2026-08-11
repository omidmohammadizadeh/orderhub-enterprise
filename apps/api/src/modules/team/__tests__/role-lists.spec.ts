import { NEW_ROLES, ALLOWED_GRANTS } from "../team.service";

// Assigning a role passes through TWO independent allowlists in team.service:
// NEW_ROLES ("is this a real role at all?") and then ALLOWED_GRANTS ("may THIS
// caller grant it?"). Adding a role to the second but not the first is a
// silent trap — the UI offers the role, the caller is permitted to grant it,
// and the request still dies with "Unknown role" before either check that
// looks relevant. That is exactly how KIOSK shipped unusable.
//
// These tests make the two lists prove they agree, so the next role added
// only has to be forgotten once.

describe("team role allowlists", () => {
  const known = new Set<string>(NEW_ROLES as readonly string[]);

  it("every grantable role is a role the service recognises", () => {
    const orphans: string[] = [];
    for (const [caller, grants] of Object.entries(ALLOWED_GRANTS)) {
      for (const g of grants) {
        if (!known.has(g)) orphans.push(`${caller} → ${g}`);
      }
    }
    expect(orphans).toEqual([]);
  });

  it("every role has an entry in ALLOWED_GRANTS, even if it grants nothing", () => {
    // A missing key reads as "grants nothing" by accident rather than by
    // decision. Device accounts must grant nothing — that should be written
    // down, not inferred from a gap.
    const missing = [...known].filter((r) => !(r in ALLOWED_GRANTS));
    expect(missing).toEqual([]);
  });

  it("keeps the device roles grantable by the people who install them", () => {
    for (const role of ["KIOSK", "KITCHEN_DISPLAY"]) {
      expect(known.has(role)).toBe(true);
      expect(ALLOWED_GRANTS.TENANT_OWNER).toContain(role);
      expect(ALLOWED_GRANTS.OWNER).toContain(role);
      // ...and can't turn round and grant anything themselves.
      expect(ALLOWED_GRANTS[role]).toEqual([]);
    }
  });
});
