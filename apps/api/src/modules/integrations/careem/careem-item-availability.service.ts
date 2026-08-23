import { Injectable, Logger } from "@nestjs/common";
import { PrismaService } from "../../../infrastructure/database/prisma.service";
import { CareemClientService } from "./careem-client.service";

// Telling Careem an item is off.
//
// Without this a snoozed item stays on sale on the SuperApp, and the only way
// a customer finds out is an order the kitchen then has to reject. Careem
// measure rejections, and their FAQ treats them as a partner problem.
//
// ── Their availability endpoint is not their catalog endpoint ───────────────
//
// PATCH /catalogs/{catalog_id}/items flips items in place, takes at most 40 at
// a time, and is not subject to the two-minute catalog floor or the five
// minutes a catalog takes to appear. It is the only sensible way to 86
// something: republishing the whole menu to hide one pizza would be rejected
// as too frequent and would take five minutes to land.
//
// ── The catalog id is the branch id ─────────────────────────────────────────
//
// We publish one catalog per branch and name it after the branch, so there is
// nothing to look up. If that ever changes, this is the second place that
// needs to know.
//
// ── There is no "until" ─────────────────────────────────────────────────────
//
// Careem take active true or false and nothing else. A TIMED snooze therefore
// has to be restored by us when it expires — unlike Just Eat, where their own
// nextAvailableAt brings it back. The existing snooze-expiry sweep already
// calls the restore path, so this works, but it means a Careem item stays off
// if our sweep stops running.

/** Their per-call ceiling. Chunked rather than rejected — a caller 86ing a
 *  whole category should not have to know their limit. */
const MAX_ITEMS_PER_CALL = 40;

@Injectable()
export class CareemItemAvailabilityService {
  private readonly logger = new Logger(CareemItemAvailabilityService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly client: CareemClientService,
  ) {}

  /**
   * Push one item's availability.
   *
   * Never throws. A marketplace refusing an 86 must not fail the snooze the
   * operator just made — the item is off on the till either way, and the
   * alternative is a kitchen that cannot mark something unavailable because a
   * third party is down.
   */
  async pushItemAvailability(args: {
    tenantId: string;
    itemId: string;
    locationId?: string | null;
    available: boolean;
  }): Promise<void> {
    await this.pushMany({
      tenantId: args.tenantId,
      locationId: args.locationId,
      items: [{ id: args.itemId, active: args.available }],
    });
  }

  /** Several at once, chunked to their limit. */
  async pushMany(args: {
    tenantId: string;
    locationId?: string | null;
    items: Array<{ id: string; active: boolean }>;
  }): Promise<void> {
    if (!args.items.length) return;
    if (!this.client.configured()) return;

    const location = await this.locationFor(args.tenantId, args.locationId);
    if (!location) return;

    for (let i = 0; i < args.items.length; i += MAX_ITEMS_PER_CALL) {
      const chunk = args.items.slice(i, i + MAX_ITEMS_PER_CALL);
      try {
        await this.client.request(
          `/catalogs/${encodeURIComponent(location.id)}/items`,
          {
            method: "PATCH",
            brandId: location.brandId,
            branchId: location.id,
            body: {
              items: chunk.map((item) => ({
                // Our MenuItem.id is the catalog id we published, which is
                // what makes this a push rather than a lookup.
                id: item.id,
                status: item.active ? "active" : "inactive",
              })),
            },
          },
        );
      } catch (err) {
        this.logger.warn(
          `Careem availability push failed for ${chunk.length} item(s) at ` +
            `${location.id}: ${(err as Error).message}`,
        );
      }
    }
  }

  /**
   * The Careem-connected location this snooze belongs to.
   *
   * A snooze can arrive without one — the operator was on "all locations" —
   * and there is no safe guess. Pushing to whichever shop happened to be first
   * would 86 an item at a branch nobody touched.
   */
  private async locationFor(tenantId: string, locationId?: string | null) {
    if (!locationId) return null;
    return this.prisma.location.findFirst({
      where: {
        id: locationId,
        deletedAt: null,
        brand: { tenantId },
        // Careem serve three countries. Anywhere else has no branch to update.
        country: { in: ["AE", "JO", "SA"] },
      },
      select: { id: true, brandId: true },
    });
  }
}
