import type { Prisma } from "@orderhub/database";

// The ticket number: a short number a kitchen can call out, counting 1, 2, 3
// per shop per trading day. Order ID stays the unique reference; a ticket number
// repeats from one day to the next and between shops.

// The trading day turns over at 4am shop time, so a shift running past midnight
// doesn't restart its numbers halfway through.
const DAY_ROLLOVER_HOURS = 4;

/** The shop's trading day, as YYYY-MM-DD. */
export function ticketBusinessDate(now: Date, timezone: string): string {
  const shifted = new Date(now.getTime() - DAY_ROLLOVER_HOURS * 60 * 60 * 1000);
  const inZone = (timeZone: string) =>
    new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(shifted);
  try {
    return inZone(timezone);
  } catch {
    // A bad timezone on a location must not cost the shop its ticket number.
    return inZone("Europe/London");
  }
}

/**
 * Claims the next ticket number inside the order's own transaction.
 *
 * The row lock this takes is held until the order commits, so two orders at
 * once can't share a number, and a rolled-back order (a duplicate webhook, say)
 * hands its number back instead of leaving a gap.
 *
 * Never throws: a ticket number is a convenience and must not cost a shop an
 * order. The savepoint matters because any failed statement otherwise aborts
 * the whole Postgres transaction, order included.
 */
export async function claimTicketNumber(
  tx: Prisma.TransactionClient,
  locationId: string,
  businessDate: string,
  onError: (error: unknown) => void,
): Promise<number | null> {
  let savepointTaken = false;
  try {
    await tx.$executeRaw`SAVEPOINT claim_ticket_number`;
    savepointTaken = true;
    const rows = await tx.$queryRaw<Array<{ lastValue: number }>>`
      INSERT INTO "order_ticket_sequences" ("locationId", "businessDate", "lastValue", "updatedAt")
      VALUES (${locationId}, ${businessDate}, 1, NOW())
      ON CONFLICT ("locationId", "businessDate")
      DO UPDATE SET "lastValue" = "order_ticket_sequences"."lastValue" + 1, "updatedAt" = NOW()
      RETURNING "lastValue"`;
    await tx.$executeRaw`RELEASE SAVEPOINT claim_ticket_number`;
    return rows[0]?.lastValue ?? null;
  } catch (error) {
    onError(error);
    if (savepointTaken) {
      await tx.$executeRaw`ROLLBACK TO SAVEPOINT claim_ticket_number`.catch(() => {});
    }
    return null;
  }
}
