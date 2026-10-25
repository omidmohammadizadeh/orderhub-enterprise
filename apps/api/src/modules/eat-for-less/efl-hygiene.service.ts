// Eat For Less — food hygiene monitor.
//
// Every night each listed shop's FSA rating is fetched again. Below the
// platform minimum, the shop is hidden from the app; back at or above it,
// it comes back by itself. Only a hide this service made is undone by it:
// a shop hidden for another reason stays hidden.

import { BadRequestException, Injectable, Logger, NotFoundException } from "@nestjs/common";
import { Cron } from "@nestjs/schedule";
import { PrismaService } from "../../infrastructure/database/prisma.service";
import { EflChecksService, fsaIdFromUrl, ratingBelowMinimum } from "./efl-checks";

export const HYGIENE_REASON = "HYGIENE";

/** What hiddenReason becomes after a check. */
export function nextHiddenReason(current: string | null, below: boolean): string | null {
  if (below) return current ?? HYGIENE_REASON;
  return current === HYGIENE_REASON ? null : current;
}

@Injectable()
export class EflHygieneService {
  private readonly logger = new Logger(EflHygieneService.name);
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly checks: EflChecksService,
  ) {}

  @Cron("0 0 3 * * *", { timeZone: "Europe/London" })
  async nightly() {
    if (this.running) return;
    this.running = true;
    try {
      const summary = await this.checkAll();
      this.logger.log(`Hygiene check: ${summary.checked} checked, ${summary.hidden} hidden, ${summary.restored} restored`);
    } catch (err) {
      this.logger.warn(`Hygiene check failed: ${(err as Error).message}`);
    } finally {
      this.running = false;
    }
  }

  async checkAll() {
    const [listings, config] = await Promise.all([
      this.prisma.eflListing.findMany({
        where: { fsaEstablishmentId: { not: null } },
        select: { id: true, fsaEstablishmentId: true, hiddenReason: true },
      }),
      this.prisma.eflConfig.findUnique({ where: { id: "default" } }),
    ]);
    const minimum = config?.minHygieneRating ?? 2;
    let hidden = 0;
    let restored = 0;
    for (const l of listings) {
      const before = l.hiddenReason;
      const after = await this.checkOne(l.id, l.fsaEstablishmentId!, before, minimum);
      if (after === HYGIENE_REASON && before !== HYGIENE_REASON) hidden++;
      if (before === HYGIENE_REASON && after !== HYGIENE_REASON) restored++;
    }
    return { checked: listings.length, hidden, restored };
  }

  /** Check one listing now; returns its hiddenReason afterwards. A failed
   *  lookup changes nothing — an FSA outage must not hide every shop. */
  private async checkOne(listingId: string, fsaId: string, current: string | null, minimum: number) {
    const result = await this.checks.hygieneById(fsaId);
    if (!result) return current;
    const next = nextHiddenReason(current, ratingBelowMinimum(result.rating, minimum));
    await this.prisma.eflListing.update({
      where: { id: listingId },
      data: { hygieneRating: result.rating, hygieneCheckedAt: new Date(), hiddenReason: next },
    });
    return next;
  }

  async list() {
    const [rows, config] = await Promise.all([
      this.prisma.eflListing.findMany({
        orderBy: { createdAt: "asc" },
        include: { location: { select: { name: true, city: true, postcode: true, brand: { select: { name: true } } } } },
      }),
      this.prisma.eflConfig.findUnique({ where: { id: "default" } }),
    ]);
    const minimum = config?.minHygieneRating ?? 2;
    return {
      minimum,
      shops: rows.map((r) => ({
        listingId: r.id,
        shopName: r.location?.brand?.name ?? r.location?.name ?? null,
        town: r.location?.city ?? null,
        fsaEstablishmentId: r.fsaEstablishmentId,
        rating: r.hygieneRating,
        checkedAt: r.hygieneCheckedAt,
        belowMinimum: ratingBelowMinimum(r.hygieneRating, minimum),
        hiddenForHygiene: r.hiddenReason === HYGIENE_REASON,
      })),
    };
  }

  /**
   * Link a listing to its FSA record — from a ratings.food.gov.uk link, or
   * by searching the shop's own name and postcode — then check it at once.
   */
  async link(listingId: string, url?: string) {
    const listing = await this.prisma.eflListing.findUnique({
      where: { id: listingId },
      include: { location: { select: { name: true, postcode: true, brand: { select: { name: true } } } } },
    });
    if (!listing) throw new NotFoundException("Listing not found");
    let fsaId = url ? fsaIdFromUrl(url) : null;
    if (url && !fsaId) throw new BadRequestException("That isn't a ratings.food.gov.uk business link.");
    if (!fsaId) {
      const name = listing.location?.brand?.name ?? listing.location?.name ?? "";
      const found = listing.location?.postcode
        ? await this.checks.findHygiene({ name, postcode: listing.location.postcode })
        : null;
      if (!found) throw new BadRequestException("No FSA record found at this shop's postcode. Paste its ratings link instead.");
      fsaId = found.establishmentId;
    }
    await this.prisma.eflListing.update({ where: { id: listingId }, data: { fsaEstablishmentId: fsaId } });
    const config = await this.prisma.eflConfig.findUnique({ where: { id: "default" } });
    await this.checkOne(listingId, fsaId, listing.hiddenReason, config?.minHygieneRating ?? 2);
    return (await this.list()).shops.find((s) => s.listingId === listingId);
  }
}
