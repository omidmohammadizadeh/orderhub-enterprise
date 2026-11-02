"use client";

// The shop's UK food hygiene rating, from the Food Standards Agency.
//
// The API keeps it fresh (re-fetched nightly) and sends `hygiene` only when
// the shop has a rating and hasn't hidden it. Drawn in the familiar sticker
// style — black card, six circles 0–5, the score enlarged — with CSS only;
// the FSA's own artwork is theirs. Tapping opens the official record.
//
// Scotland's scheme gives "Pass" / "Improvement Required" rather than a
// number, and an unrated shop reads "AwaitingInspection" or "Exempt"; those
// show as a plain text chip.

export interface StorefrontHygiene {
  rating: string;
  ratingDate: string | null;
  url: string;
}

const NUMERIC_LABEL = [
  "Urgent improvement necessary",
  "Major improvement necessary",
  "Improvement necessary",
  "Generally satisfactory",
  "Good",
  "Very good",
];

/** "AwaitingInspection" → "Awaiting inspection". */
function readableStatus(rating: string): string {
  const spaced = rating.replace(/([a-z])([A-Z])/g, "$1 $2").trim();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1).toLowerCase();
}

/** "2025-08-05T00:00:00" → "5 Aug 2025". The FSA sends a date, not an instant. */
function ratedOn(ratingDate: string | null): string | null {
  if (!ratingDate || !/^\d{4}-\d{2}-\d{2}/.test(ratingDate)) return null;
  const d = new Date(`${ratingDate.slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
}

export function HygieneBadge({ hygiene }: { hygiene: StorefrontHygiene | null | undefined }) {
  if (!hygiene?.rating) return null;
  const rating = hygiene.rating.trim();
  const score = /^[0-5]$/.test(rating) ? Number(rating) : null;
  const date = ratedOn(hygiene.ratingDate);

  const label =
    score !== null
      ? `Food hygiene rating ${score} out of 5, ${NUMERIC_LABEL[score]}`
      : `Food hygiene: ${readableStatus(rating)}`;

  return (
    <a
      href={hygiene.url}
      target="_blank"
      rel="noopener noreferrer"
      aria-label={`${label}${date ? `, rated ${date}` : ""}. Opens the Food Standards Agency page in a new tab.`}
      className="group inline-flex max-w-full items-center gap-3 rounded-xl border border-sf-border bg-sf-surface p-1.5 pr-3 text-left transition-colors hover:border-sf-border-strong focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--sf-accent)]"
    >
      {score !== null ? (
        <span
          aria-hidden
          className="flex shrink-0 flex-col items-center rounded-lg bg-black px-2 pb-1.5 pt-1 ring-1 ring-white/10"
        >
          <span className="text-[8px] font-extrabold uppercase leading-none tracking-[0.08em] text-[#9bd13c]">
            Food hygiene rating
          </span>
          <span className="mt-1 flex items-center gap-[3px]">
            {[0, 1, 2, 3, 4, 5].map((n) =>
              n === score ? (
                <span
                  key={n}
                  className="grid h-[22px] w-[22px] place-items-center rounded-full bg-white text-[13px] font-black leading-none text-black ring-2 ring-[#9bd13c]"
                >
                  {n}
                </span>
              ) : (
                <span
                  key={n}
                  className="grid h-[14px] w-[14px] place-items-center rounded-full bg-[#9bd13c] text-[9px] font-bold leading-none text-black"
                >
                  {n}
                </span>
              ),
            )}
          </span>
        </span>
      ) : (
        <span
          aria-hidden
          className="shrink-0 rounded-lg bg-black px-2 py-1.5 text-[10px] font-extrabold uppercase leading-tight tracking-[0.06em] text-[#9bd13c] ring-1 ring-white/10"
        >
          Food
          <br />
          hygiene
        </span>
      )}
      <span className="min-w-0 leading-tight">
        <span className="block text-[13px] font-semibold text-sf-text">
          {score !== null ? NUMERIC_LABEL[score] : readableStatus(rating)}
        </span>
        <span className="mt-0.5 block text-[11px] text-sf-muted">
          {date ? `Rated ${date}` : "Food Standards Agency"}
          <span className="group-hover:underline"> · View</span>
        </span>
      </span>
    </a>
  );
}
