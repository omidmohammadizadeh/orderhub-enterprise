import { matchOption } from './voice-menu-match';

/**
 * Is this note actually a paid topping in disguise?
 *
 * A note says how the kitchen should make something — "well done", "no
 * onions", "extra hot". It is not a way to hand out a chargeable ingredient
 * for free, which is exactly what "extra green pepper" in the note field does:
 * no price on the line, and it prints as an instruction rather than as an
 * option. Call DCjjeFGw (order 5CWRR) went out that way.
 *
 * Only ADDITIVE phrasing counts, and only when the thing named really is a
 * PAID option on this item. So "no onions" and "extra hot" stay notes, a free
 * option stays a note because nobody is under-charged, and "extra green
 * pepper" on a pizza that sells green pepper is refused and sent back through
 * modifierNames where it gets its price.
 *
 * Its own module, with no Nest or Anthropic imports, so the rule that decides
 * whether a shop gets paid can be tested on its own.
 */
export function chargeableInNote(item: any, note: string): string | null {
  const text = String(note ?? '').trim();
  if (!text) return null;
  const groups: any[] = item?.modifierGroups ?? [];
  if (!groups.length) return null;

  const ADD = /^(?:extra|add|added|plus|with|also)\b\s*/i;
  const DROP = /^(?:no|not|without|hold|minus|skip|less)\b/i;

  // Read it in segments. "extra jalapeno and green pepper" is two toppings,
  // and a single greedy match swallowed the tail so the second one was never
  // checked — which is precisely the pair the caller asked for on 5CWRR.
  // Whether we are adding carries across "and" until a removal turns it off,
  // so "no onions and extra cheese" drops the onions and still catches the
  // cheese.
  let adding = false;
  for (const rawSegment of text.split(/[,;.]|\band\b|\bplus\b/i)) {
    let segment = rawSegment.trim();
    if (!segment) continue;
    if (DROP.test(segment)) {
      adding = false;
      continue;
    }
    if (ADD.test(segment)) {
      adding = true;
      segment = segment.replace(ADD, '').trim();
    }
    if (!adding || !segment) continue;
    for (const g of groups) {
      const hit = matchOption<any>(segment, g.options, g.name);
      // A free option is fine as a note — nobody is under-charged.
      if (hit && Number(hit.item.price ?? 0) > 0) return String(hit.item.name);
    }
  }
  return null;
}
