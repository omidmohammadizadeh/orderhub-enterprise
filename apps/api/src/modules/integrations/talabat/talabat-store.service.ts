import { BadRequestException, Injectable, Logger, Optional } from "@nestjs/common";
import { PrismaService } from "../../../infrastructure/database/prisma.service";
import { ActivityLogService } from "../../logs/activity-log.service";
import { TalabatClientService } from "./talabat-client.service";
import { talabatSettings, type TalabatConnectionRow } from "./talabat-connection.service";
import type { TalabatClosedReason, TalabatVendorAvailabilityUpdate } from "./talabat-types";

// Phase TB-5 — is the restaurant open on Talabat? ("DH Branch Availability
// Status", mandatory for certification.)
//
//   GET /v2/chains/{chainCode}/remoteVendors/{posVendorId}/availability
//     → [{ availabilityState, changeable, closedReason, closedUntil,
//          platformKey, platformRestaurantId, availabilityStates, … }]
//     204 = "acknowledged, result not yet available — retry in a couple of
//     seconds"
//   PUT  same path
//     { availabilityState: OPEN | CLOSED | CLOSED_TODAY | CLOSED_UNTIL,
//       platformKey, platformRestaurantId, closedReason?, closingMinutes? }
//
// Their instruction: GET first and check `changeable` — "otherwise the
// request will be unsuccessful" — because Talabat themselves close vendors
// (too many rejected orders, compliance, onboarding…) and only Talabat can
// reopen those. The PUT also needs platformKey + platformRestaurantId, which
// only the GET tells us. So every change is GET → decide → PUT.
//
// And the other direction: the middleware pushes vendor availability changes
// to our plugin (PUT /remoteId/{remoteId}/availability), with a timestamp to
// order them by. Recorded on the connection so "why is Talabat closed?" has
// an answer on our side.

export interface TalabatAvailabilityRow {
  availabilityState?: string;
  changeable?: boolean;
  closedReason?: string | null;
  closedUntil?: string | null;
  checkinAt?: string | null;
  nextOpeningAt?: string | null;
  platformKey?: string;
  platformRestaurantId?: string;
  platformId?: string;
  platformType?: string;
  availabilityStates?: string[];
  closingReasons?: string[];
}

@Injectable()
export class TalabatStoreService {
  private readonly logger = new Logger(TalabatStoreService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly client: TalabatClientService,
    @Optional() private readonly activity?: ActivityLogService,
  ) {}

  private path(c: TalabatConnectionRow): string {
    const chain = talabatSettings(c).chainCode;
    if (!chain || !c.externalStoreId) {
      throw new BadRequestException("This Talabat connection needs a chain code and remote ID first.");
    }
    return `/v2/chains/${encodeURIComponent(chain)}/remoteVendors/${encodeURIComponent(c.externalStoreId)}/availability`;
  }

  async getAvailability(c: TalabatConnectionRow): Promise<TalabatAvailabilityRow[]> {
    const path = this.path(c);
    // 204 means "ask again shortly". Three tries, two seconds apart.
    for (let attempt = 0; attempt < 3; attempt++) {
      const res = await this.client.request<TalabatAvailabilityRow[] | TalabatAvailabilityRow>(path, { method: "GET" });
      if (res.status !== 204) {
        const rows = Array.isArray(res.data) ? res.data : res.data ? [res.data] : [];
        await this.remember(c, rows);
        return rows;
      }
      await new Promise((r) => setTimeout(r, 2000));
    }
    throw new BadRequestException("Talabat haven't produced the availability yet — try again in a few seconds.");
  }

  /**
   * Open or close on Talabat.
   *
   * `minutes` closes for that long (CLOSED_UNTIL); without it, closes until
   * reopened (CLOSED) — or for the rest of today when that is all the vendor
   * is allowed. Refuses when Talabat say the state isn't ours to change.
   */
  async setAvailability(
    c: TalabatConnectionRow,
    input: { open: boolean; minutes?: number | null; reason?: TalabatClosedReason },
  ): Promise<{ ok: true; state: string }> {
    const rows = await this.getAvailability(c);
    const row = rows[0];
    if (!row?.platformKey || !row.platformRestaurantId) {
      throw new BadRequestException("Talabat returned no platform vendor for this remote ID — is it mapped on their side?");
    }
    if (row.changeable === false) {
      throw new BadRequestException(
        `Talabat have this vendor ${row.availabilityState ?? "closed"}` +
          (row.closedReason ? ` (${row.closedReason})` : "") +
          " and it can't be changed from the POS. Contact Talabat.",
      );
    }
    const allowed = new Set(row.availabilityStates ?? []);
    let state: string;
    let body: Record<string, unknown>;
    if (input.open) {
      state = "OPEN";
      body = { availabilityState: "OPEN", platformKey: row.platformKey, platformRestaurantId: row.platformRestaurantId };
    } else {
      const minutes = input.minutes && input.minutes > 0 ? Math.round(input.minutes) : null;
      state = minutes ? "CLOSED_UNTIL" : allowed.size && !allowed.has("CLOSED") ? "CLOSED_TODAY" : "CLOSED";
      if (allowed.size && !allowed.has(state)) {
        throw new BadRequestException(
          `Talabat only allow ${[...allowed].join(", ")} for this vendor right now, not ${state}.`,
        );
      }
      const reasons = new Set(row.closingReasons ?? []);
      const reason = input.reason ?? "TOO_BUSY_KITCHEN";
      body = {
        availabilityState: state,
        platformKey: row.platformKey,
        platformRestaurantId: row.platformRestaurantId,
        closedReason: reasons.size && !reasons.has(reason) ? "OTHER" : reason,
        ...(minutes ? { closingMinutes: minutes } : {}),
      };
    }
    await this.client.request(this.path(c), { method: "PUT", body });
    this.activity?.record({
      tenantId: c.tenantId,
      brandId: c.brandId,
      locationId: c.locationId,
      category: "STATUS",
      channel: "TALABAT",
      action: input.open ? "store.resume" : "store.pause",
      status: "SUCCESS",
      message: input.open
        ? "Talabat vendor reopened"
        : `Talabat vendor closed (${state}${body.closingMinutes ? `, ${body.closingMinutes} min` : ""})`,
    });
    await this.prisma.brandPlatformConnection
      .update({ where: { id: c.id }, data: { status: input.open ? "connected" : "suspended" } })
      .catch(() => undefined);
    return { ok: true, state };
  }

  /** PauseService hook: mirror our pause for one brand at one location. */
  async reconcile(args: {
    tenantId: string;
    brandId: string;
    locationId: string;
    paused: boolean;
    resumeAt?: Date | string | null;
    mode?: string | null;
  }): Promise<void> {
    if (!this.client.configured()) return;
    const c = await this.prisma.brandPlatformConnection.findFirst({
      where: {
        tenantId: args.tenantId,
        brandId: args.brandId,
        locationId: args.locationId,
        platform: "TALABAT",
        status: { in: ["connected", "suspended"] },
        externalStoreId: { not: null },
      },
    });
    if (!c || !talabatSettings(c).chainCode) return;
    const until = args.resumeAt ? new Date(args.resumeAt).getTime() : NaN;
    const minutes = Number.isFinite(until) ? Math.ceil((until - Date.now()) / 60_000) : null;
    try {
      await this.setAvailability(c, {
        open: !args.paused,
        minutes: minutes && minutes > 0 ? minutes : null,
        reason: /busy/i.test(String(args.mode ?? "")) ? "TOO_BUSY_KITCHEN" : "OTHER",
      });
    } catch (e: any) {
      this.activity?.record({
        tenantId: c.tenantId,
        brandId: c.brandId,
        locationId: c.locationId,
        category: "STATUS",
        channel: "TALABAT",
        action: args.paused ? "store.pause" : "store.resume",
        status: "ERROR",
        message: `Talabat vendor could not be ${args.paused ? "closed" : "reopened"}: ${e?.message ?? e}`,
      });
    }
  }

  /**
   * The middleware telling us the vendor's availability changed.
   *
   * Idempotent and ordered by `timestamp`: "notifications with an older
   * timestamp than the current known state should be ignored". Open when no
   * closure has started and not yet ended.
   */
  async onVendorAvailability(c: TalabatConnectionRow, body: TalabatVendorAvailabilityUpdate): Promise<{ applied: boolean }> {
    const s = talabatSettings(c);
    const prev = s.talabatAvailability as { timestamp?: string } | undefined;
    const ts = Date.parse(body?.timestamp ?? "");
    if (!Number.isFinite(ts)) return { applied: false };
    if (prev?.timestamp && Date.parse(prev.timestamp) > ts) return { applied: false };

    const now = Date.now();
    const active = (body.closures ?? []).filter((x) => {
      const start = Date.parse(x.start);
      const end = x.end ? Date.parse(x.end) : Infinity;
      return Number.isFinite(start) && start <= now && end > now;
    });
    const open = active.length === 0;
    const state = {
      timestamp: new Date(ts).toISOString(),
      open,
      closures: body.closures ?? [],
      receivedAt: new Date().toISOString(),
    };
    await this.prisma.brandPlatformConnection
      .update({ where: { id: c.id }, data: { metadata: { ...(c.metadata as any), talabatAvailability: state } as any } })
      .catch(() => undefined);
    const lead = active[0];
    this.activity?.record({
      tenantId: c.tenantId,
      brandId: c.brandId,
      locationId: c.locationId,
      category: "STATUS",
      channel: "TALABAT",
      action: "store.talabat_availability",
      status: open ? "INFO" : "WARNING",
      message: open
        ? "Talabat report the vendor is open"
        : `Talabat report the vendor is CLOSED (${lead!.reason}${lead!.end ? ` until ${lead!.end.slice(0, 16).replace("T", " ")} UTC` : ", no end time"})` +
          (lead!.changeable ? "" : " — only Talabat can reopen it"),
      details: state,
    });
    return { applied: true };
  }

  /** Keep platformKey / platformRestaurantId on the connection for display. */
  private async remember(c: TalabatConnectionRow, rows: TalabatAvailabilityRow[]) {
    const r = rows[0];
    if (!r) return;
    const s = talabatSettings(c);
    if (s.platformKey === r.platformKey && s.platformVendorId === r.platformRestaurantId) return;
    await this.prisma.brandPlatformConnection
      .update({
        where: { id: c.id },
        data: {
          metadata: {
            ...(c.metadata as any),
            platformKey: r.platformKey ?? s.platformKey,
            platformVendorId: s.platformVendorId ?? r.platformRestaurantId,
          } as any,
        },
      })
      .catch(() => undefined);
  }
}
