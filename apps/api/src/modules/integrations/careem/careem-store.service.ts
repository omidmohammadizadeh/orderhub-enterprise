import { BadRequestException, Injectable, Logger } from "@nestjs/common";
import { PrismaService } from "../../../infrastructure/database/prisma.service";
import { hoursConfigured, toWeekHours } from "../../../common/opening-hours.util";
import { CareemClientService } from "./careem-client.service";
import {
  transformCareemHours,
  type CareemWeekStart,
} from "./careem-hours.transformer";

// Phase CA-4 — registering our shops with Careem, and keeping them open or shut.
//
// ── Brands and branches carry OUR ids ───────────────────────────────────────
//
// Both endpoints take an id "provided by vendor or restaurant". We publish
// Brand.id and Location.id, which is what lets an inbound order name its own
// location with no mapping table anywhere.
//
// ── Two switches that sound alike and are not ───────────────────────────────
//
// PATCH /branches/{id}/status is the POS INTEGRATION toggle: off means orders
// go to the branch's Careem tablet instead of to us. Careem leave it off on a
// new branch deliberately, so a catalog can be checked before orders start
// flowing. Turning it on is the moment Careem orders become our problem.
//
// POST /branches/{id}/visibility/status is whether CUSTOMERS can order at all.
// Their `offline` state can only be set and cleared by Careem operations — a
// partner cannot reactivate out of it, which is why the read endpoint returns
// `can_reactivate`.
//
// ── Mapping is manual and blocks everything ─────────────────────────────────
//
// A branch we create is not a real outlet until Careem's operations team maps
// it. Until then a catalog push fails with "branch_id is not mapped". Nothing
// here can do that step; `state` on the branch reports whether it has happened.

export /**
 * What we publish when a shop has set no hours at all.
 *
 * Careem reject 00:00 as an end time, so a full day is 00:00–23:59. It loses a
 * minute at midnight, which is theirs to explain, not ours to work around.
 */
const ALL_WEEK_OPEN = Object.fromEntries(
  [
    "monday",
    "tuesday",
    "wednesday",
    "thursday",
    "friday",
    "saturday",
    "sunday",
  ].map((d) => [d, [{ from: "00:00", to: "23:59" }]]),
);

/** Careem cap a page at 20 and default to it. */
const PAGE_SIZE = 20;
/** 4000 branches. Far past any real chain, and a stop for a broken cursor. */
const MAX_PAGES = 200;

export interface CareemBranch {
  id: string;
  name: string;
  brand_id: string;
  state: "UNMAPPED" | "MAPPED";
  pos_integration?: boolean;
  visibility?: string;
}

/**
 * One Careem branch, spelled out.
 *
 * A brand trading from a location is its own branch on Careem, so a kitchen
 * with five brands is five branches. Which ids those are comes from the
 * connection row (see CareemConnectionService); the location-only routes on the
 * Careem page keep using the location's own id and default brand, which is how
 * the first staging branch was registered.
 */
export interface CareemTarget {
  branchId: string;
  brandId: string;
  locationId: string;
}

@Injectable()
export class CareemStoreService {
  private readonly logger = new Logger(CareemStoreService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly client: CareemClientService,
  ) {}

  /**
   * Which day is 1.
   *
   * Careem confirmed in writing (30 Sep 2026): 1 = Sunday ... 7 = Saturday.
   * CAREEM_WEEK_START=monday remains only as an escape hatch.
   */
  private get weekStart(): CareemWeekStart {
    return process.env.CAREEM_WEEK_START === "monday" ? "monday" : "sunday";
  }

  /** Register one of our brands. Careem 409 a duplicate, which for our purposes
   *  is success — the brand is already there. */
  async registerBrand(tenantId: string, brandId: string) {
    const brand = await this.prisma.brand.findFirst({
      where: { id: brandId, tenantId, deletedAt: null },
      select: { id: true, name: true },
    });
    if (!brand) throw new BadRequestException("Brand not found");

    try {
      return await this.client.request("/brands", {
        method: "POST",
        body: { id: brand.id, name: brand.name },
      });
    } catch (err) {
      if (/409|already exists|duplicate/i.test((err as Error).message)) {
        this.logger.log(`Careem brand ${brand.id} already registered`);
        return { id: brand.id, name: brand.name, alreadyRegistered: true };
      }
      throw err;
    }
  }

  /**
   * Register or rename one of our locations as a Careem branch.
   *
   * PUT is create-or-update on their side, so this is safe to re-run — which
   * is how a renamed shop stays in step.
   */
  async registerBranch(
    tenantId: string,
    locationId: string,
  ): Promise<CareemBranch> {
    const location = await this.location(tenantId, locationId, {
      id: true,
      name: true,
      brandId: true,
    });

    const branch = await this.client.request<CareemBranch>(
      `/branches/${encodeURIComponent(location.id)}`,
      {
        method: "PUT",
        brandId: location.brandId,
        body: { name: location.name },
      },
    );
    if (branch?.state !== "MAPPED") {
      // Not an error — it is the expected state of a new branch, and the next
      // step is a human one at Careem. Said plainly so nobody sits waiting for
      // it to resolve itself.
      this.logger.warn(
        `Careem branch ${location.id} is ${branch?.state ?? "UNMAPPED"}. ` +
          `Careem operations must map it to an outlet before a catalog can be ` +
          `pushed or orders can arrive.`,
      );
    }
    return branch;
  }

  /** Whether orders reach US or the branch's own Careem tablet. Off by default
   *  on a new branch, on purpose. */
  async setPosIntegration(
    tenantId: string,
    locationId: string,
    active: boolean,
  ) {
    const { brandId } = await this.location(tenantId, locationId, {
      brandId: true,
    });
    return this.client.request(
      `/branches/${encodeURIComponent(locationId)}/status`,
      { method: "PATCH", brandId, body: { active } },
    );
  }

  /** Whether customers can place orders. 1 = active, 2 = inactive. */
  async setVisibility(tenantId: string, locationId: string, canOrder: boolean) {
    const { brandId } = await this.location(tenantId, locationId, {
      brandId: true,
    });
    return this.client.request(
      `/branches/${encodeURIComponent(locationId)}/visibility/status`,
      { method: "POST", brandId, body: { status_id: canOrder ? 1 : 2 } },
    );
  }

  /**
   * Stop taking Careem orders for a while — a slammed kitchen, a dead fryer.
   *
   * Careem bring the branch back themselves when the time is up, which is the
   * point: nobody has to remember to turn it back on.
   */
  async pauseFor(tenantId: string, locationId: string, minutes: number) {
    const till = Math.round(minutes);
    if (!Number.isFinite(till) || till < 1) {
      throw new BadRequestException("Pause length must be at least 1 minute");
    }
    const { brandId } = await this.location(tenantId, locationId, {
      brandId: true,
    });
    return this.client.request(
      `/branches/${encodeURIComponent(locationId)}/visibility/status/expiries`,
      { method: "POST", brandId, body: { status_id: 2, till_time: till } },
    );
  }

  /**
   * Read the branch's state on the SuperApp.
   *
   * `offline` is Careem operations having taken it down, and `can_reactivate`
   * comes back false — a partner cannot switch out of it. Surfacing that
   * difference saves an operator pressing a button that will never work.
   */
  async visibility(tenantId: string, locationId: string) {
    const { brandId } = await this.location(tenantId, locationId, {
      brandId: true,
    });
    return this.client.request<{
      status: "active" | "inactive" | "offline";
      reason: string | null;
      can_reactivate: boolean | null;
    }>(`/branches/${encodeURIComponent(locationId)}/visibility/status`, {
      method: "GET",
      brandId,
    });
  }

  /**
   * Publish the shop's opening hours, split across midnight the way Careem
   * model them.
   *
   * The location's own hours win and the brand's are the fallback, matching
   * how every other channel resolves them. They are stored in two different
   * shapes — the location keeps the legacy `[{day, open, close}]` array, the
   * brand keeps the day→slots map — so both go through toWeekHours first.
   */
  async publishHours(tenantId: string, locationId: string) {
    const location = await this.location(tenantId, locationId, {
      id: true,
      brandId: true,
    });
    return this.publishHoursFor(tenantId, {
      branchId: location.id,
      brandId: location.brandId,
      locationId: location.id,
    });
  }

  /** Location hours first, then the selling brand's, as Deliveroo and HubRise. */
  async publishHoursFor(tenantId: string, target: CareemTarget) {
    const [location, brand] = await Promise.all([
      this.prisma.location.findFirst({
        where: { id: target.locationId, deletedAt: null, brand: { tenantId } },
        select: { openingHours: true },
      }),
      this.prisma.brand.findFirst({
        where: { id: target.brandId, tenantId },
        select: { openingHours: true },
      }),
    ]);
    if (!location) throw new BadRequestException("Location not found");

    const raw = hoursConfigured(location.openingHours)
      ? location.openingHours
      : brand?.openingHours;
    const locationId = target.locationId;

    // A shop with no hours set anywhere is OPEN, not shut.
    //
    // isCurrentlyOpen treats an unconfigured schedule as always open, and that
    // is what the operator sees on their own till. Publishing seven inactive
    // days would have made Careem the only place the shop was closed — and
    // silently, since nothing on our side would look wrong. Careem's FAQ lists
    // exactly this as why a branch shows closed on the SuperApp.
    const configured = hoursConfigured(raw);
    if (!configured) {
      this.logger.warn(
        `${locationId} has no opening hours on the location or its brand. ` +
          `Publishing OPEN all week to Careem, matching how the till treats ` +
          `it — set real hours before this shop goes live.`,
      );
    }
    const operational_hours = configured
      ? transformCareemHours(toWeekHours(raw), this.weekStart)
      : transformCareemHours(ALL_WEEK_OPEN, this.weekStart);
    await this.client.request("/operational-hours", {
      method: "PUT",
      brandId: target.brandId,
      branchId: target.branchId,
      body: { operational_hours },
    });
    return { ok: true, days: operational_hours };
  }

  /** Create or rename a branch. PUT is create-or-update on their side. */
  async putBranch(target: CareemTarget, name: string): Promise<CareemBranch> {
    return this.client.request<CareemBranch>(
      `/branches/${encodeURIComponent(target.branchId)}`,
      { method: "PUT", brandId: target.brandId, body: { name } },
    );
  }

  /** The branch as Careem see it now, or null if they have no such branch. */
  async readBranch(target: CareemTarget): Promise<
    (CareemBranch & { catalog_id?: string | null; active?: boolean }) | null
  > {
    const rows = await this.paged<
      CareemBranch & { catalog_id?: string | null; active?: boolean }
    >("/branches", target.brandId);
    return rows.find((b) => b.id === target.branchId) ?? null;
  }

  async setPosIntegrationFor(target: CareemTarget, active: boolean) {
    return this.client.request(
      `/branches/${encodeURIComponent(target.branchId)}/status`,
      { method: "PATCH", brandId: target.brandId, body: { active } },
    );
  }

  async setVisibilityFor(target: CareemTarget, canOrder: boolean) {
    return this.client.request(
      `/branches/${encodeURIComponent(target.branchId)}/visibility/status`,
      {
        method: "POST",
        brandId: target.brandId,
        body: { status_id: canOrder ? 1 : 2 },
      },
    );
  }

  async pauseTargetFor(target: CareemTarget, minutes: number) {
    const till = Math.round(minutes);
    if (!Number.isFinite(till) || till < 1) {
      throw new BadRequestException("Pause length must be at least 1 minute");
    }
    return this.client.request(
      `/branches/${encodeURIComponent(target.branchId)}/visibility/status/expiries`,
      {
        method: "POST",
        brandId: target.brandId,
        body: { status_id: 2, till_time: till },
      },
    );
  }

  async readVisibility(target: CareemTarget) {
    return this.client.request<{
      status: "active" | "inactive" | "offline";
      reason: string | null;
      can_reactivate: boolean | null;
    }>(`/branches/${encodeURIComponent(target.branchId)}/visibility/status`, {
      method: "GET",
      brandId: target.brandId,
    });
  }

  async listBrands() {
    return this.paged("/brands");
  }

  async listBranches(tenantId: string, brandId: string) {
    const brand = await this.prisma.brand.findFirst({
      where: { id: brandId, tenantId, deletedAt: null },
      select: { id: true },
    });
    if (!brand) throw new BadRequestException("Brand not found");
    return this.paged("/branches", brandId);
  }

  /**
   * Walk every page.
   *
   * Careem cap a page at 20 and default to it, so a single GET quietly returns
   * the first twenty of anything — a chain with more branches than that would
   * look like it had exactly twenty.
   */
  private async paged<T>(path: string, brandId?: string): Promise<T[]> {
    const out: T[] = [];
    for (let page = 1; page <= MAX_PAGES; page++) {
      const res = await this.client.request<{ data?: T[] } | T[]>(
        `${path}?page_number=${page}&page_size=${PAGE_SIZE}`,
        { method: "GET", ...(brandId ? { brandId } : {}) },
      );
      const rows = Array.isArray(res) ? res : (res?.data ?? []);
      out.push(...rows);
      if (rows.length < PAGE_SIZE) return out;
    }
    this.logger.warn(
      `Careem ${path} still had more after ${MAX_PAGES} pages — stopping.`,
    );
    return out;
  }

  /**
   * Register a location's branch, and send its hours if it is already mapped.
   *
   * Never turns POS integration on. Careem's process puts that at branch setup,
   * which is safe for a brand-new outlet, but a shop already trading on Careem
   * would start sending us live orders the moment operations map it, before our
   * catalog exists there and with item ids we cannot name. Orders go on as a
   * deliberate last step.
   */
  async onboardLocation(tenantId: string, locationId: string) {
    const { brandId } = await this.location(tenantId, locationId, {
      brandId: true,
    });

    await this.registerBrand(tenantId, brandId);
    const branch = await this.registerBranch(tenantId, locationId);
    const mapped = branch?.state === "MAPPED";

    // Careem refuse hours for an unmapped branch, and a new branch always is.
    if (mapped) await this.publishHours(tenantId, locationId);

    return {
      branch,
      mapped,
      nextSteps: [
        ...(mapped ? [] : ["Ask Careem operations to map this branch to an outlet"]),
        "Publish the menu",
        "Turn orders on once the catalog shows COMPLETED",
        "Ask Careem operations to disable order auto-acceptance for this branch",
        // From their FAQ: a branch logged into the Careem partner portal has
        // staff accepting orders there, so nothing reaches us.
        "Make sure the shop is logged OUT of the Careem partner portal",
      ],
    };
  }

  /** One tenant-scoped lookup, so no route can push another tenant's shop to
   *  Careem under our credentials. Locations carry no tenantId of their own —
   *  they hang off the brand. */
  private async location<S extends Record<string, unknown>>(
    tenantId: string,
    locationId: string,
    select: S,
  ) {
    const location = await this.prisma.location.findFirst({
      where: { id: locationId, deletedAt: null, brand: { tenantId } },
      select: select as never,
    });
    if (!location) throw new BadRequestException("Location not found");
    return location as {
      id: string;
      name: string;
      brandId: string;
      openingHours: unknown;
      brand: unknown;
    };
  }
}
