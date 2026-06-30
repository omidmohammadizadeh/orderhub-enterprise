// Phase AW-15 — HubRise location pause sync.
//
// Mirrors our PauseService state onto HubRise. HubRise exposes ONE
// endpoint that covers paused / busy / normal, location-wide only:
//
//   PATCH /v1/locations/:id
//   { mode: "paused" | "busy" | "normal",
//     resume_at?: ISO,
//     reason?: string,
//     extra_preparation_time?: minutes }
//
// We treat this as best-effort. The local pause is authoritative for
// our own surfaces (storefront / POS); HubRise mirroring is what makes
// the marketplace partners (Uber Eats / Deliveroo / Just Eat) stop
// routing orders.

import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { PrismaService } from "../../../infrastructure/database/prisma.service";
import { CredentialEncryptionService } from "../credential-encryption.service";

const HUBRISE_DAYS = [
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
  "sunday",
] as const;

/**
 * Normalise our internal opening-hours into HubRise's shape:
 *   { monday: [{ from: "09:00", to: "22:00" }], … }
 * Handles all three shapes we store:
 *   - location editor map:  { monday: { enabled, slots: [{from,to}] } }
 *   - brand map:            { monday: [{from,to}] }
 *   - legacy array:         [{ day, open, close }]
 * Disabled days / empty slots are dropped (HubRise treats an omitted day as
 * closed). Returns null when nothing is configured.
 */
export function toHubRiseOpeningHours(
  hours: any,
): Record<string, { from: string; to: string }[]> | null {
  if (!hours) return null;
  const out: Record<string, { from: string; to: string }[]> = {};

  if (Array.isArray(hours)) {
    for (const h of hours) {
      const day = String(h?.day ?? "").toLowerCase();
      const from = h?.open ?? h?.from;
      const to = h?.close ?? h?.to;
      if (!(HUBRISE_DAYS as readonly string[]).includes(day) || !from || !to) continue;
      (out[day] ??= []).push({ from: String(from), to: String(to) });
    }
    return Object.keys(out).length ? out : null;
  }

  if (typeof hours !== "object") return null;
  for (const day of HUBRISE_DAYS) {
    const d = (hours as any)[day];
    if (!d) continue;
    let slots: any[];
    if (Array.isArray(d)) slots = d;
    else if (d.enabled === false) continue;
    else slots = Array.isArray(d.slots) ? d.slots : [];
    const clean = slots
      .filter((s) => s && s.from && s.to)
      .map((s) => ({ from: String(s.from), to: String(s.to) }));
    if (clean.length) out[day] = clean;
  }
  return Object.keys(out).length ? out : null;
}

@Injectable()
export class HubRiseLocationPauseService {
  private readonly logger = new Logger(HubRiseLocationPauseService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly credentialEncryption: CredentialEncryptionService,
  ) {}

  /**
   * Push the current pause state to HubRise. Caller is the PauseService;
   * it resolves the final state (busy / paused / normal) first, we just
   * post it through. Silent no-op if the location has no HubRise
   * connection — we don't want to error out the operator's pause
   * because a sibling integration is missing.
   */
  async syncFromPause(args: {
    locationId: string;
    mode: "paused" | "busy" | "normal";
    resumeAt: Date | null;
    reason: string | null;
    extraPrepTime: number | null;
  }): Promise<void> {
    const loc = await this.prisma.location.findUnique({
      where: { id: args.locationId },
      select: {
        hubriseCredentials: true,
        hubriseLocationId: true,
      },
    });
    if (!loc?.hubriseLocationId || !loc.hubriseCredentials) return;

    const decrypted = this.credentialEncryption.decrypt(
      loc.hubriseCredentials as Record<string, unknown>,
    ) as Record<string, string>;
    const accessToken = decrypted.accessToken;
    if (!accessToken) return;

    // HubRise expects the acceptance fields nested under
    // `order_acceptance` on PATCH /locations/:id.
    //
    //   paused: { mode, resume_at?, reason? }
    //   busy:   { mode, resume_at?, extra_preparation_time }  ← NO reason
    //   normal: { mode }
    //
    // Sending `reason` while mode=busy returns 422 from HubRise
    // ("/order_acceptance/reason is not a valid key"). Confirmed
    // against the live API + their own admin payload — busy mode
    // doesn't surface a reason to the customer.
    const acceptance: Record<string, any> = { mode: args.mode };
    if (args.mode === "paused") {
      if (args.resumeAt) acceptance.resume_at = args.resumeAt.toISOString();
      if (args.reason) acceptance.reason = args.reason;
    } else if (args.mode === "busy") {
      // HubRise treats null as "no auto-reset" — match the operator's
      // sample payload exactly so this hits the spec.
      acceptance.resume_at = args.resumeAt ? args.resumeAt.toISOString() : null;
      if (args.extraPrepTime) {
        acceptance.extra_preparation_time = args.extraPrepTime;
      }
    }
    const body = { order_acceptance: acceptance };

    const baseUrl =
      this.config.get<string>("app.platforms.hubrise.baseUrl") ??
      "https://api.hubrise.com/v1";
    const url = `${baseUrl}/locations/${loc.hubriseLocationId.toLowerCase()}`;

    const res = await fetch(url, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        "X-Access-Token": accessToken,
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(
        `HubRise PATCH /locations/${loc.hubriseLocationId} → ${res.status}: ${text.slice(0, 200)}`,
      );
    }
    this.logger.log(
      `HubRise location ${loc.hubriseLocationId} → mode=${args.mode}` +
        (args.resumeAt ? ` resume_at=${args.resumeAt.toISOString()}` : ""),
    );
  }

  /**
   * Phase AW-16 — push opening_hours + preparation_time to HubRise.
   *
   * HubRise expects opening_hours as
   *   { monday: [{from:"11:00", to:"23:59"}, ...], tuesday: [...], … }
   * keyed by lowercase weekday name. preparation_time is an integer
   * (minutes). We send what we have on the brand and silently no-op
   * if the brand has no HubRise-connected location.
   *
   * Caller: PublishHoursService when the operator hits the new
   * "Publish hours" button with channel = HUBRISE.
   */
  async publishHours(args: {
    locationId: string;
    openingHours: any;
    prepTime: number | null;
  }): Promise<void> {
    const loc = await this.prisma.location.findUnique({
      where: { id: args.locationId },
      select: {
        hubriseCredentials: true,
        hubriseLocationId: true,
      },
    });
    if (!loc?.hubriseLocationId || !loc.hubriseCredentials) return;

    const decrypted = this.credentialEncryption.decrypt(
      loc.hubriseCredentials as Record<string, unknown>,
    ) as Record<string, string>;
    const accessToken = decrypted.accessToken;
    if (!accessToken) return;

    const body: Record<string, any> = {};
    const oh = toHubRiseOpeningHours(args.openingHours);
    if (oh) body.opening_hours = oh;
    if (args.prepTime != null && args.prepTime > 0) {
      body.preparation_time = args.prepTime;
    }
    if (Object.keys(body).length === 0) return;

    const baseUrl =
      this.config.get<string>("app.platforms.hubrise.baseUrl") ??
      "https://api.hubrise.com/v1";
    const url = `${baseUrl}/locations/${loc.hubriseLocationId.toLowerCase()}`;

    const res = await fetch(url, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        "X-Access-Token": accessToken,
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(
        `HubRise PATCH /locations/${loc.hubriseLocationId} hours → ${res.status}: ${text.slice(0, 200)}`,
      );
    }
    this.logger.log(
      `HubRise location ${loc.hubriseLocationId} hours published (prep=${args.prepTime ?? "-"})`,
    );
  }
}
