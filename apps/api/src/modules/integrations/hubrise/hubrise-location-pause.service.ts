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
    // `order_acceptance` on PATCH /locations/:id. Sending mode /
    // resume_at / reason at the root level returns 422 "is not a
    // valid key" — confirmed against the live API.
    const acceptance: Record<string, any> = { mode: args.mode };
    if (args.mode !== "normal") {
      if (args.resumeAt) acceptance.resume_at = args.resumeAt.toISOString();
      if (args.reason) acceptance.reason = args.reason;
      if (args.mode === "busy" && args.extraPrepTime) {
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
    if (args.openingHours && typeof args.openingHours === "object") {
      body.opening_hours = args.openingHours;
    }
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
