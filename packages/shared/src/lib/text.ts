/**
 * Capitalise the first character, leave the rest exactly as typed.
 *
 * Menu names get typed in a hurry on a tablet, and "margherita" next to
 * "Pepperoni" looks like a mistake to a customer. This tidies the first
 * letter and nothing else.
 *
 * Deliberately NOT title case. Title-casing menu names does more harm than
 * good: "BBQ Chicken" becomes "Bbq Chicken", "Coca Cola 330ml" becomes
 * "330Ml", and "Pizza and Chips" becomes "Pizza And Chips". Every one of
 * those is worse than what the operator typed. Touching one character can't
 * damage an acronym, a unit or a brand name.
 *
 * Numbers and symbols are safe by construction — toUpperCase() is a no-op on
 * them, so "10 inch" stays "10 inch" rather than becoming "10 Inch".
 */
export function capitaliseFirst(input: string): string {
  const trimmed = (input ?? "").trim();
  if (!trimmed) return trimmed;

  // Skip leading symbols, but stop dead at a digit.
  //
  // Modifiers are routinely written "+chicken", "- onion", "£2 extra". Simply
  // uppercasing character zero does nothing for those, because character zero
  // is "+". So we look past punctuation for the first letter.
  //
  // Digits are the reason this isn't just "find the first letter": skipping
  // them too would turn "10 inch" into "10 Inch", which is exactly the kind of
  // damage this function exists to avoid. Hitting a digit first means the name
  // starts with a number and there is nothing to capitalise.
  const i = trimmed.search(/[\p{L}\p{N}]/u);
  if (i < 0) return trimmed; // no letters or digits at all — leave it be
  const first = trimmed.charAt(i);
  if (!/\p{L}/u.test(first)) return trimmed; // starts with a number
  return trimmed.slice(0, i) + first.toUpperCase() + trimmed.slice(i + 1);
}
