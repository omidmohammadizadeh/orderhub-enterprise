/**
 * Wall-clock time in the shop's timezone, both directions.
 *
 * A booking is the first thing this phone line does where the exact minute
 * matters and it is not "now". An order is cooked in twenty minutes wherever
 * the server happens to be running; a table on Friday at seven is Friday at
 * seven in the restaurant, and the API runs in UTC. Get that wrong by an hour
 * over a British summer and a party arrives to a table that is still being
 * eaten off.
 *
 * No timezone library in this repo, so the offset is read out of Intl for the
 * instant in question — which is the only way to get it right across a clock
 * change, since the offset is a property of the moment and not of the zone.
 *
 * Its own module, with no Nest imports, so the arithmetic can be tested on
 * its own against a fixed clock.
 */

/** How far the zone is from UTC at that instant, in milliseconds. */
function offsetAt(instant: Date, timezone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(instant);
  const got: Record<string, string> = {};
  for (const p of parts) got[p.type] = p.value;
  const wall = Date.UTC(
    Number(got.year),
    Number(got.month) - 1,
    Number(got.day),
    // Intl writes midnight as 24 in some environments.
    Number(got.hour) % 24,
    Number(got.minute),
    Number(got.second),
  );
  return wall - instant.getTime();
}

/**
 * "2026-09-12T19:00" in the shop's timezone → the actual instant.
 *
 * Two passes: the offset is looked up near the answer and then again at it,
 * so an evening either side of a clock change lands on the right hour. The
 * hour that happens twice in autumn resolves to the first of the two, which
 * is the one a restaurant means.
 */
export function whenInShop(local: string, timezone: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{1,2}):(\d{2})/.exec(String(local ?? '').trim());
  if (!m) return null;
  const wall = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]));
  if (!Number.isFinite(wall)) return null;
  let guess = wall - offsetAt(new Date(wall), timezone);
  guess = wall - offsetAt(new Date(guess), timezone);
  const out = new Date(guess);
  return Number.isNaN(out.getTime()) ? null : out;
}

/** What the clock on the restaurant wall says now, as the model should write it. */
export function shopNow(timezone: string, now: Date = new Date()): string {
  const p = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).formatToParts(now);
  const got: Record<string, string> = {};
  for (const x of p) got[x.type] = x.value;
  return `${got.year}-${got.month}-${got.day}T${String(Number(got.hour) % 24).padStart(2, '0')}:${got.minute}`;
}

/**
 * The time said out loud, the way a person confirming a booking says it.
 *
 * The day of the week is not decoration. It is the only part of a date a
 * caller checks — nobody catches "the twelfth" being wrong, everybody
 * catches "Friday" being wrong — and it is the model's arithmetic being read
 * back to the one person who knows the answer.
 */
export function spokenWhen(when: Date, timezone: string): string {
  const f = new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone,
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });
  const got: Record<string, string> = {};
  for (const p of f.formatToParts(when)) if (p.type !== 'literal') got[p.type] = p.value;
  // Midnight and noon come back as hour "0" from some builds of Intl, and a
  // phone line that says "zero pm" to a caller is a phone line nobody trusts
  // with the rest of the booking.
  const hour = got.hour === '0' || got.hour === '00' ? '12' : got.hour;
  const minutes = got.minute === '00' ? '' : `:${got.minute}`;
  const period = String(got.dayPeriod ?? '').toLowerCase().replace(/\s/g, '');
  return `${got.weekday} ${got.day} ${got.month} at ${hour}${minutes}${period}`;
}

/** The same day said aloud, without the time — for listing free slots. */
export function spokenDay(when: Date, timezone: string): string {
  return spokenWhen(when, timezone).split(' at ')[0]!;
}
