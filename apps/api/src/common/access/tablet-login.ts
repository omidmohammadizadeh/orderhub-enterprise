// Shared counter-tablet sign-in — one per shop, like Uber Eats Order Manager.
//
// The account is an ordinary User with role LOCATION_TABLET and exactly one
// UserLocation row. Its "username" is what staff type on the tablet; under the
// hood it is stored as an email on a subdomain nothing is ever sent to, so the
// users table, the unique index and the whole login path stay exactly as they
// are for everyone else. Typing the full address works too.

export const TABLET_ROLE = "LOCATION_TABLET";

/** Never receives mail — it only makes the username fit the email column. */
export const TABLET_LOGIN_DOMAIN = "tablet.orderhubpos.com";

/** Owner-controlled switch stored in User.permissions. Off by default. */
export const TABLET_ANALYTICS_PERMISSION = "tablet:analytics";

const USERNAME_RE = /^[a-z0-9][a-z0-9-]{2,62}$/;

export function isTabletUsername(value: string): boolean {
  return USERNAME_RE.test(value.trim().toLowerCase());
}

export function tabletEmailFor(username: string): string {
  return `${username.trim().toLowerCase()}@${TABLET_LOGIN_DOMAIN}`;
}

export function tabletUsernameFromEmail(email: string): string {
  return email.replace(`@${TABLET_LOGIN_DOMAIN}`, "");
}

/**
 * What the login box was given → the email to look up. A bare tablet username
 * gains the tablet domain; anything with an "@" is left exactly as it was, so
 * every existing email login behaves the same as before.
 */
export function normalizeLoginIdentifier(raw: string): string {
  const value = (raw ?? "").trim().toLowerCase();
  if (value.includes("@")) return value;
  return isTabletUsername(value) ? tabletEmailFor(value) : value;
}

/** Same rule as Uber's reset dialog: 8+ characters, a letter and a number. */
export function tabletPasswordProblem(password: unknown): string | null {
  if (typeof password !== "string" || password.length < 8) {
    return "Password must be at least 8 characters";
  }
  if (password.length > 128) return "Password is too long";
  if (!/[0-9]/.test(password) || !/[^0-9]/.test(password)) {
    return "Password must include a number and a non-digit character";
  }
  return null;
}
