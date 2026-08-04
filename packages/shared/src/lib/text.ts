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
  return trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
}
