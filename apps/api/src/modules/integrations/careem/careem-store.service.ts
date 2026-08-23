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

export /** Careem cap a page at 20 and default to it. */
const PAGE_SIZE = 20;
/** 4000 branches. Far past any real chain, and a stop for a broken cursor. */
const MAX_PAGES = 200;

export interface CareemBranch {
  id: string;
  name: string;
  brand_id: string;
  state: "UNMAPPED" | "MAPPED";
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
   * Careem's schema says `day_of_week` is an integer and their examples show
   * 1 and 5 without ever saying which day either is. ISO (Monday = 1) is the
   * default; the Gulf trading week starts on Sunday, so their own convention
   * may well too. Set CAREEM_WEEK_START=sunday if a test branch shows the week
   * shifted by a day — it cannot be told apart locally.
   */
  private get weekStart(): CareemWeekStart {
    return process.env.CAREEM_WEEK_START === "sunday" ? "sunday" : "monday";
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
      openingHours: true,
      brand: { select: { openingHours: true } },
    });

    const raw = hoursConfigured(location.openingHours)
      ? location.openingHours
      : (location.brand as { openingHours: unknown } | null)?.openingHours;

    const operational_hours = transformCareemHours(
      toWeekHours(raw),
      this.weekStart,
    );
    await this.client.request("/operational-hours", {
      method: "PUT",
      brandId: location.brandId,
      branchId: location.id,
      body: { operational_hours },
    });
    return { ok: true, days: operational_hours };
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
   * Everything needed to take orders at one location, in their documented
   * order: brand, branch, POS integration, hours.
   *
   * POS integration goes on here because their integration process puts it at
   * branch setup — step 4, before mapping and before the catalog. That is safe
   * precisely because of the step that follows it: an UNMAPPED branch is not
   * an outlet on the SuperApp, so no customer can order from it and the switch
   * has nothing to route yet.
   *
   * An ALREADY-MAPPED branch is the case where it is not safe, and the switch
   * is left alone. Turning it on there would take a shop that is trading on
   * its own Careem tablet and point its live orders at a menu we have not
   * pushed yet. Re-running onboarding on a working shop must not do that.
   */
  async onboardLocation(tenantId: string, locationId: string) {
    const { brandId } = await this.location(tenantId, locationId, {
      brandId: true,
    });

    await this.registerBrand(tenantId, brandId);
    const branch = await this.registerBranch(tenantId, locationId);
    const mapped = branch?.state === "MAPPED";

    if (!mapped) await this.setPosIntegration(tenantId, locationId, true);
    await this.publishHours(tenantId, locationId);

    return {
      branch,
      mapped,
      posIntegrationEnabled: !mapped,
      nextSteps: mapped
        ? [
            "This branch is already mapped and may be trading. POS integration " +
              "was left as it was — publish the menu first, then switch it on " +
              "deliberately.",
            "Publish the menu",
          ]
        : [
            "Ask Careem operations to map this branch to an outlet",
            "Publish the menu",
            "Check the catalog on the SuperApp APK Careem share with partners",
            // Both from their FAQ, and both make a correct integration look
            // broken. Auto-acceptance is on by default at some branches and
            // only their operations team can turn it off; and a branch left
            // logged into the Careem portal has staff accepting orders there,
            // so nothing reaches us and the statuses disagree.
            "Ask Careem operations to disable order auto-acceptance for this branch",
            "Make sure the shop is logged OUT of the Careem partner portal — " +
              "orders accepted there never reach us",
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
