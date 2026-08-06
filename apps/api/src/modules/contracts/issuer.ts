/**
 * Who is SENDING the contract — the other party on the certificate.
 *
 * A signature certificate that names only the signer answers half the
 * question. "Omid signed something on 6 August" is not evidence of an
 * agreement until it also says who they agreed with, and under what company
 * number. Both sides go on the page.
 *
 * Defaults are the platform's own details and can be overridden per contract
 * at send time, because the same install may issue agreements on behalf of
 * more than one entity.
 */

export interface Issuer {
  name: string;
  companyNumber?: string | null;
  address?: string | null;
  email?: string | null;
}

/** Order Hub Solutions Ltd — overridable by env for a different entity. */
export function defaultIssuer(get: (k: string) => string | undefined): Issuer {
  return {
    name: get("CONTRACT_ISSUER_NAME") ?? "Order Hub Solutions Ltd",
    companyNumber: get("CONTRACT_ISSUER_COMPANY_NO") ?? "16608545",
    address:
      get("CONTRACT_ISSUER_ADDRESS") ??
      "5 Sunningdale Drive, Washington, NE37 2LL",
    email: get("CONTRACT_ISSUER_EMAIL") ?? get("EMAIL_FROM") ?? null,
  };
}

/**
 * Per-contract overrides win field by field, so an operator can change just
 * the signing email and keep the registered company details.
 */
export function resolveIssuer(base: Issuer, override?: Partial<Issuer> | null): Issuer {
  if (!override) return base;
  const pick = (a?: string | null, b?: string | null) =>
    a && String(a).trim() ? String(a).trim() : b ?? null;
  return {
    name: pick(override.name, base.name) || base.name,
    companyNumber: pick(override.companyNumber, base.companyNumber),
    address: pick(override.address, base.address),
    email: pick(override.email, base.email),
  };
}
