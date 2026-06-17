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

    const body: Record<string, any> = { mode: args.mode };
    if (args.mode !== "normal") {
      if (args.resumeAt) body.resume_at = args.resumeAt.toISOString();
      if (args.reason) body.reason = args.reason;
      if (args.mode === "busy" && args.extraPrepTime) {
        body.extra_preparation_time = args.extraPrepTime;
      }
    }

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
}
