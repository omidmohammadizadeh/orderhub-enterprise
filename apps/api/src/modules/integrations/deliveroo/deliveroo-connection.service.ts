import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from "@nestjs/common";
import { PrismaService } from "../../../infrastructure/database/prisma.service";
import { DeliverooClientService } from "./deliveroo-client.service";

// Phase BA-2 — Deliveroo per-brand connection + store control.
//
// Per brand you connect Deliveroo with a Site ID; we resolve the Deliveroo
// Brand ID from it (required for every Menu/Site/Hours call) and store both on
// the BrandPlatformConnection row (externalStoreId = Site ID, externalBrandId
// = Deliveroo Brand ID). Then: store status get/pause/unpause, opening hours,
// and prep time.

const DAYS = [
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
  "sunday",
] as const;

/** Normalise our opening-hours (location {enabled,slots}, brand array, or the
 *  legacy [{day,open,close}] shape) into Deliveroo's
 *  { monday: [{ local_start_time, local_end_time }], … }. Closed/empty days
 *  are omitted. */
export function toDeliverooOpeningHours(
  hours: any,
): Record<string, { local_start_time: string; local_end_time: string }[]> {
  const out: Record<
    string,
    { local_start_time: string; local_end_time: string }[]
  > = {};
  const push = (day: string, slots: any[]) => {
    const clean = (slots ?? [])
      .filter((s) => s && s.from && s.to)
      .map((s) => ({
        local_start_time: String(s.from),
        local_end_time: String(s.to),
      }));
    if (clean.length) out[day] = clean;
  };

  if (Array.isArray(hours)) {
    for (const h of hours) {
      const day = String(h?.day ?? "").toLowerCase();
      if ((DAYS as readonly string[]).includes(day) && h?.open && h?.close) {
        (out[day] ??= []).push({
          local_start_time: String(h.open),
          local_end_time: String(h.close),
        });
      }
    }
    return out;
  }
  if (hours && typeof hours === "object") {
    for (const day of DAYS) {
      const d = (hours as any)[day];
      if (!d) continue;
      if (Array.isArray(d)) push(day, d);
      else if (d.enabled === false) continue;
      else push(day, Array.isArray(d.slots) ? d.slots : []);
    }
  }
  return out;
}

@Injectable()
export class DeliverooConnectionService {
  private readonly logger = new Logger(DeliverooConnectionService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly client: DeliverooClientService,
  ) {}

  /** Resolve the Deliveroo Brand ID for a Site ID (rest-…). */
  async fetchBrandId(storeId: string): Promise<string> {
    const json = await this.client.request<{ brand_id?: string | string[] }>(
      "GET",
      `/site/v1/restaurant_locations/${encodeURIComponent(storeId)}`,
    );
    const b = Array.isArray(json?.brand_id) ? json.brand_id[0] : json?.brand_id;
    if (!b) {
      throw new BadRequestException(
        "Deliveroo didn't return a Brand ID for that Site ID. Check the Site ID.",
      );
    }
    return b;
  }

  /** Connect (or re-connect) a brand's Deliveroo store. */
  async connect(
    tenantId: string,
    dto: {
      brandId: string;
      locationId: string;
      storeId: string;
      deliverooBrandId?: string;
    },
  ) {
    await this.assertAccess(tenantId, dto.brandId, dto.locationId);
    if (!this.client.configured) {
      throw new BadRequestException(
        "Deliveroo isn't configured on the server yet (missing client credentials).",
      );
    }
    const storeId = dto.storeId.trim();
    if (!storeId) throw new BadRequestException("Site ID is required.");
    const deliverooBrandId =
      dto.deliverooBrandId?.trim() || (await this.fetchBrandId(storeId));

    const row = await this.prisma.brandPlatformConnection.upsert({
      where: {
        brandId_locationId_platform: {
          brandId: dto.brandId,
          locationId: dto.locationId,
          platform: "DELIVEROO",
        },
      },
      create: {
        tenantId,
        brandId: dto.brandId,
        locationId: dto.locationId,
        platform: "DELIVEROO",
        status: "connected",
        externalStoreId: storeId,
        externalBrandId: deliverooBrandId,
      },
      update: {
        status: "connected",
        externalStoreId: storeId,
        externalBrandId: deliverooBrandId,
        lastError: null,
      },
    });
    return this.view(row);
  }

  async disconnect(tenantId: string, connectionId: string) {
    const row = await this.prisma.brandPlatformConnection.findFirst({
      where: { id: connectionId, tenantId, platform: "DELIVEROO" },
    });
    if (!row) throw new NotFoundException("Deliveroo connection not found");
    await this.prisma.brandPlatformConnection.update({
      where: { id: connectionId },
      data: {
        status: "not_connected",
        externalStoreId: null,
        externalBrandId: null,
        lastError: null,
      },
    });
    return { ok: true };
  }

  /** GET the store's OPEN/CLOSED status from Deliveroo. */
  async storeStatus(tenantId: string, connectionId: string) {
    const c = await this.connected(tenantId, connectionId);
    const json = await this.client.request<{ status?: string }>(
      "GET",
      `/site/v1/brands/${c.externalBrandId}/sites/${c.externalStoreId}/status`,
    );
    const s = String(json?.status ?? "").toUpperCase();
    return { status: s === "OPEN" || s === "CLOSED" ? s : (s || "UNKNOWN") };
  }

  /** Pause (CLOSED) / resume (OPEN) the store on Deliveroo. */
  async setStoreOpen(tenantId: string, connectionId: string, open: boolean) {
    const c = await this.connected(tenantId, connectionId);
    await this.client.request(
      "PUT",
      `/site/v1/brands/${c.externalBrandId}/sites/${c.externalStoreId}/status`,
      { status: open ? "OPEN" : "CLOSED" },
    );
    await this.prisma.brandPlatformConnection.update({
      where: { id: connectionId },
      data: { status: open ? "connected" : "suspended" },
    });
    return { status: open ? "OPEN" : "CLOSED" };
  }

  /** Push the location's opening hours + prep time to Deliveroo. */
  async publishHours(tenantId: string, connectionId: string) {
    const c = await this.connected(tenantId, connectionId);
    const loc = await this.prisma.location.findUnique({
      where: { id: c.locationId },
      select: {
        openingHours: true,
        prepTime: true,
        busyExtraPrepTime: true,
        brand: { select: { openingHours: true, prepTime: true } },
      },
    });
    // Location-first (same precedence as HubRise + WhatsApp), fall back to brand.
    const rawHours =
      loc && hasHours((loc as any).openingHours)
        ? (loc as any).openingHours
        : (loc?.brand as any)?.openingHours;
    const hours = toDeliverooOpeningHours(rawHours);
    const days = Object.keys(hours);
    // Deliveroo's Site API wants the map WRAPPED under `opening_hours`:
    //   { "opening_hours": { "monday": [{ local_start_time, local_end_time }] } }
    // Posting the bare map is accepted (2xx) but silently ignored — which is
    // why "publish" reported success yet nothing changed on Deliveroo.
    if (days.length) {
      this.logger.log(
        `Deliveroo publishHours conn=${connectionId} brand=${c.externalBrandId} site=${c.externalStoreId} days=[${days.join(",")}]`,
      );
      await this.client.request(
        "POST",
        `/site/v1/brands/${c.externalBrandId}/sites/${c.externalStoreId}/opening_hours`,
        { opening_hours: hours },
      );
    } else {
      this.logger.warn(
        `Deliveroo publishHours conn=${connectionId}: no opening hours to send (location + brand both empty) — pushing prep only`,
      );
    }
    // Prep/workload times are a best-effort SECOND step. Some Deliveroo sites
    // (e.g. managed-prep or certain fulfilment types) reject setting workload
    // tiers with "this site cannot set 'moderate'". That must NOT fail the whole
    // publish — the opening hours above already landed (200).
    const prep = await this.pushPrepTime(c, loc);
    return { ok: true, daysPublished: days.length, prepPushed: prep.ok, prepWarning: prep.warning };
  }

  private async pushPrepTime(
    c: any,
    loc: any,
  ): Promise<{ ok: boolean; warning?: string }> {
    const base =
      (loc?.prepTime ?? null) ?? (loc?.brand?.prepTime ?? null) ?? 15;
    const busy = base + (loc?.busyExtraPrepTime ?? 5);
    const path = `/site/v1/brands/${c.externalBrandId}/sites/${c.externalStoreId}/workload/times`;

    // Try the full 3-tier payload; if the site rejects a tier it "cannot set"
    // (typically 'moderate'), retry with just quiet + busy; then give up quietly.
    const attempts: Record<string, number>[] = [
      { quiet: base, moderate: base, busy },
      { quiet: base, busy },
    ];
    let lastErr = "";
    for (const body of attempts) {
      try {
        await this.client.request("PUT", path, body);
        return { ok: true };
      } catch (err: any) {
        lastErr = String(err?.message ?? err);
        // Only bother retrying the reduced payload when the site rejected a
        // specific tier; other errors won't be fixed by dropping a key.
        if (!/cannot set/i.test(lastErr)) break;
      }
    }
    this.logger.warn(
      `Deliveroo prep/workload not set for site=${c.externalStoreId}: ${lastErr}`,
    );
    return {
      ok: false,
      warning:
        "Opening hours were published, but this Deliveroo site doesn't allow setting prep/busy times from here.",
    };
  }

  private async connected(tenantId: string, connectionId: string) {
    const row = await this.prisma.brandPlatformConnection.findFirst({
      where: { id: connectionId, tenantId, platform: "DELIVEROO" },
    });
    if (!row?.externalStoreId || !row.externalBrandId) {
      throw new BadRequestException("Deliveroo isn't connected for this brand.");
    }
    return row;
  }

  private view(row: any) {
    return {
      id: row.id,
      status: row.status,
      storeId: row.externalStoreId,
      deliverooBrandId: row.externalBrandId,
    };
  }

  private async assertAccess(
    tenantId: string,
    brandId: string,
    locationId: string,
  ) {
    const brand = await this.prisma.brand.findFirst({
      where: { id: brandId, tenantId, deletedAt: null },
      select: { id: true },
    });
    if (!brand) throw new NotFoundException("Brand not found");
    const loc = await this.prisma.location.findFirst({
      where: { id: locationId, deletedAt: null, brand: { tenantId } },
      select: { id: true },
    });
    if (!loc) throw new NotFoundException("Location not found");
  }
}

function hasHours(v: any): boolean {
  if (!v) return false;
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === "object") return Object.keys(v).length > 0;
  return false;
}
