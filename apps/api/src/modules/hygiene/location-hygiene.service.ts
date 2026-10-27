// Food hygiene rating on every shop's storefront.
//
// A location is linked to its FSA record once — from a pasted
// ratings.food.gov.uk link, or found by name at the shop's postcode — and
// the rating is re-fetched every night, so a re-inspection reaches the
// storefront badge with nobody touching it. A failed FSA call changes
// nothing: an outage must not blank every shop's badge.

import { BadRequestException, Injectable, Logger, NotFoundException } from "@nestjs/common";
import { Cron } from "@nestjs/schedule";
import { PrismaService } from "../../infrastructure/database/prisma.service";
import { FsaRatingsClient, fsaIdFromUrl, type HygieneResult } from "../../common/fsa-ratings";
import { hygieneFromResult, mergeHygiene, readHygiene, type StoredHygiene } from "./hygiene-settings";

export interface HygieneUpdate {
  fsaId?: string;
  url?: string;
  show?: boolean;
}

@Injectable()
export class LocationHygieneService {
  private readonly logger = new Logger(LocationHygieneService.name);
  private readonly fsa = new FsaRatingsClient();
  private running = false;

  constructor(private readonly prisma: PrismaService) {}

  async get(locationId: string, tenantId: string): Promise<StoredHygiene | null> {
    const loc = await this.load(locationId, tenantId);
    return readHygiene(loc.settings);
  }

  /**
   * PUT: link (or re-link) and/or flip the storefront switch.
   *
   * With a link or an id, that record is fetched. With only `show`, nothing
   * is fetched — the switch just flips. With nothing at all ("Find
   * automatically"), the shop is searched for by name at its postcode.
   */
  async update(locationId: string, tenantId: string, body: HygieneUpdate): Promise<StoredHygiene | null> {
    const loc = await this.load(locationId, tenantId);
    const current = readHygiene(loc.settings);
    const wantsLink = !!(body.fsaId || body.url) || typeof body.show !== "boolean";
    let next = current;
    if (wantsLink) {
      const result = await this.resolve(loc, body);
      next = hygieneFromResult(result, current?.fsaId === result.establishmentId ? current : null);
    }
    if (typeof body.show === "boolean" && next) next = { ...next, show: body.show };
    if (next && next !== current) await this.save(loc.id, loc.settings, next);
    return next;
  }

  /** "Refresh now": fetch the linked record again. */
  async refresh(locationId: string, tenantId: string): Promise<StoredHygiene> {
    const loc = await this.load(locationId, tenantId);
    const current = readHygiene(loc.settings);
    if (!current) throw new BadRequestException("This shop isn't linked to an FSA record yet.");
    const result = await this.fsa.hygieneById(current.fsaId);
    if (!result) throw new BadRequestException("The FSA ratings service didn't answer. Try again shortly.");
    const next = hygieneFromResult(result, current);
    await this.save(loc.id, loc.settings, next);
    return next;
  }

  @Cron("0 30 3 * * *", { timeZone: "Europe/London" })
  async nightly() {
    if (this.running) return;
    this.running = true;
    try {
      const summary = await this.refreshAll();
      this.logger.log(`Hygiene refresh: ${summary.checked} checked, ${summary.updated} updated, ${summary.failed} failed`);
    } catch (err) {
      this.logger.warn(`Hygiene refresh failed: ${(err as Error).message}`);
    } finally {
      this.running = false;
    }
  }

  async refreshAll() {
    // Filtered here rather than with a Prisma JSON-path `not` — a missing key
    // is NULL there and the filter quietly drops rows. Locations are few.
    const rows = await this.prisma.location.findMany({
      where: { deletedAt: null },
      select: { id: true, settings: true },
    });
    let updated = 0;
    let failed = 0;
    let checked = 0;
    for (const row of rows) {
      const current = readHygiene(row.settings);
      if (!current) continue;
      checked++;
      const result = await this.fsa.hygieneById(current.fsaId);
      if (!result) {
        failed++;
        continue;
      }
      // Re-read just before writing so a settings save made while we were
      // waiting on the FSA isn't thrown away.
      const fresh = await this.prisma.location.findUnique({ where: { id: row.id }, select: { settings: true } });
      const latest = readHygiene(fresh?.settings);
      if (!latest || latest.fsaId !== current.fsaId) continue;
      await this.save(row.id, fresh!.settings, hygieneFromResult(result, latest));
      updated++;
    }
    return { checked, updated, failed };
  }

  private async resolve(
    loc: { name: string; postcode: string | null; brand: { name: string } | null },
    body: HygieneUpdate,
  ): Promise<HygieneResult> {
    const linked = body.fsaId?.trim() || fsaIdFromUrl(body.url);
    if (body.url && !linked) throw new BadRequestException("That isn't a ratings.food.gov.uk business link.");
    if (linked) {
      if (!/^\d{3,}$/.test(linked)) throw new BadRequestException("An FSA id is a number, like 247023.");
      const found = await this.fsa.hygieneById(linked);
      if (!found) throw new BadRequestException("No FSA record with that id, or the FSA didn't answer.");
      return found;
    }
    if (!loc.postcode) throw new BadRequestException("Add the shop's postcode first, or paste its ratings link.");
    // The FSA lists a shop under whatever name it registered — usually the
    // brand on the sign, sometimes the location's own name.
    const names = [...new Set([loc.brand?.name, loc.name].filter((n): n is string => !!n?.trim()))];
    for (const name of names) {
      const found = await this.fsa.findHygiene({ name, postcode: loc.postcode });
      if (found) return found;
    }
    throw new BadRequestException("No FSA record found at this shop's postcode. Paste its ratings link instead.");
  }

  private async load(locationId: string, tenantId: string) {
    const loc = await this.prisma.location.findFirst({
      where: { id: locationId, deletedAt: null, brand: { tenantId } },
      select: { id: true, name: true, postcode: true, settings: true, brand: { select: { name: true } } },
    });
    if (!loc) throw new NotFoundException("Location not found");
    return loc;
  }

  private async save(locationId: string, settings: unknown, hygiene: StoredHygiene) {
    await this.prisma.location.update({
      where: { id: locationId },
      data: { settings: mergeHygiene(settings, hygiene) as any },
    });
  }
}
