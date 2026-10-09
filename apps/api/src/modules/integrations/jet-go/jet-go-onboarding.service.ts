// JET Go collect-point onboarding — registering a shop with JET without a
// human filling in a form at their end.
//
// The shape of this is dictated by one fact: POST /onboarding answers **202
// with no body**. JET has taken the request, nothing more. The collect point
// id — the thing dispatch cannot work without — appears in GET /collect-points
// at some later point, so the id has to be RESOLVED rather than returned, and
// until it resolves the location is registered but not yet dispatchable.

import { BadRequestException, Injectable, Logger, NotFoundException } from "@nestjs/common";
import { PrismaService } from "../../../infrastructure/database/prisma.service";
import {
  JetGoClientService,
  JetGoOnboardCollectPointBody,
  JetGoUpdateCollectPointBody,
} from "./jet-go-client.service";
import { DecryptedJetGoConfig, JetGoConfigService } from "./jet-go-config.service";

/**
 * ISO-3166 alpha-2 (what we store on Location.country) → alpha-3 (what JET's
 * onboarding API wants; its own example is "CAN"). Every market JET Go trades
 * in, plus the ones our platform sells into, so an unmapped country is a real
 * "JET Go doesn't go there" rather than a silent wrong code.
 */
const ISO3: Record<string, string> = {
  GB: "GBR", IE: "IRL", CA: "CAN", AU: "AUS", NZ: "NZL",
  BE: "BEL", BG: "BGR", DK: "DNK", IT: "ITA", NL: "NLD",
  PL: "POL", ES: "ESP", CH: "CHE", DE: "DEU", FR: "FRA",
  AT: "AUT", LU: "LUX", PT: "PRT", RO: "ROU", SK: "SVK",
  IL: "ISR", AE: "ARE", SA: "SAU", QA: "QAT", KW: "KWT",
};

@Injectable()
export class JetGoOnboardingService {
  private readonly logger = new Logger(JetGoOnboardingService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly client: JetGoClientService,
    private readonly config: JetGoConfigService,
  ) {}

  private db(): any {
    return this.prisma as any;
  }

  private str(v: unknown): string {
    return v == null ? "" : String(v).trim();
  }

  private async load(locationId: string, tenantId: string) {
    const location = await this.db().location.findFirst({
      where: { id: locationId, deletedAt: null },
      include: { brand: true },
    });
    if (!location) throw new NotFoundException("Location not found");
    // Location has no tenantId of its own — it hangs off the brand.
    if (this.str(location.brand?.tenantId) !== this.str(tenantId)) {
      throw new NotFoundException("Location not found");
    }
    const cfg = await this.config.getDecrypted(locationId);
    if (!cfg) {
      throw new BadRequestException(
        "Set JET Go up for this location first, then register the collect point.",
      );
    }
    if (!cfg.clientId || !cfg.clientSecret) {
      throw new BadRequestException("JET Go credentials for this location are missing.");
    }
    return { location, cfg };
  }

  /** The two halves of the name JET renders as "Brand (Branch)". */
  private names(location: any): { collectPointName: string; locationName: string } {
    const brand = this.str(location.brand?.name);
    const branch = this.str(location.name);
    // A single-site brand usually names both the same; sending the same string
    // twice would read "Pizza Uno (Pizza Uno)" on JET's side.
    if (!brand || brand.toLowerCase() === branch.toLowerCase()) {
      return { collectPointName: branch || "Store", locationName: this.str(location.city) || branch || "Store" };
    }
    return { collectPointName: brand, locationName: branch || this.str(location.city) || brand };
  }

  private country(location: any): string {
    const raw = this.str(location.country).toUpperCase() || "GB";
    if (raw.length === 3) return raw;
    const iso3 = ISO3[raw];
    if (!iso3) {
      throw new BadRequestException(
        `We don't have a JET Go country code for "${raw}". Tell us the country and we'll add it.`,
      );
    }
    return iso3;
  }

  /**
   * Register this location as a JET Go collect point.
   *
   * Refuses rather than guesses on missing data: JET validates the address and
   * coordinates at its end, and a collect point onboarded at the wrong point on
   * the map quotes the wrong price for every delivery afterwards.
   */
  async onboard(args: {
    locationId: string;
    tenantId: string;
    email?: string;
    pickupInstructions?: string;
    force?: boolean;
  }) {
    const { location, cfg } = await this.load(args.locationId, args.tenantId);

    if (cfg.collectPointId && !args.force) {
      throw new BadRequestException(
        "This location already has a JET Go collect point. Use Update details to change it, or re-register with force if JET asked you to.",
      );
    }

    const address = this.str(location.addressLine1);
    const city = this.str(location.city);
    const lat = Number(location.latitude);
    const lng = Number(location.longitude);
    if (!address || !city) {
      throw new BadRequestException(
        "This location needs an address line and a city before JET Go can register it.",
      );
    }
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || (lat === 0 && lng === 0)) {
      throw new BadRequestException(
        "This location has no coordinates yet. Save its postcode in Location settings so it geocodes, then register it.",
      );
    }
    const phone = this.str(location.phone) || this.str(location.brand?.phone);
    if (!phone) {
      throw new BadRequestException(
        "This location needs a phone number — JET Go requires one for the collect point.",
      );
    }

    const { collectPointName, locationName } = this.names(location);
    const referenceId = `OH-${Date.now().toString(36).toUpperCase()}`;
    const body: JetGoOnboardCollectPointBody = {
      referenceId,
      collectPointName,
      locationName,
      email:
        this.str(args.email) ||
        this.str(process.env.JET_GO_CONTACT_EMAIL) ||
        "support@orderhubsolutions.com",
      phoneNumber: phone,
      // Our own location id. JET echoes it back on the collect point, which is
      // the only reliable way to tell which of several pending registrations
      // became which collect point.
      corporateIdentifier: args.locationId,
      location: {
        latitude: lat,
        longitude: lng,
        address: [address, this.str(location.addressLine2)].filter(Boolean).join(", "),
        city,
        country: this.country(location),
        ...(this.str(location.postcode) ? { postalCode: this.str(location.postcode) } : {}),
        // Capital P. The PATCH endpoint spells the same field pickUpInstructions.
        ...(this.str(args.pickupInstructions)
          ? { PickupInstructions: this.str(args.pickupInstructions) }
          : {}),
      },
    };

    try {
      await this.client.onboardCollectPoint(cfg, body);
    } catch (err: any) {
      const detail = String(err?.message ?? err).split(/→ \d+: /).pop()?.trim();
      await this.db().jetGoConfig.update({
        where: { locationId: args.locationId },
        data: {
          onboardingReference: referenceId,
          onboardingStatus: "FAILED",
          onboardingError: detail?.slice(0, 500) ?? null,
          onboardingAt: new Date(),
        },
      });
      this.logger.warn(`JET Go onboarding failed for location=${args.locationId}: ${err?.message ?? err}`);
      throw new BadRequestException(`JET Go refused the registration: ${detail ?? "unknown error"}`);
    }

    await this.db().jetGoConfig.update({
      where: { locationId: args.locationId },
      data: {
        onboardingReference: referenceId,
        onboardingStatus: "PENDING",
        onboardingError: null,
        onboardingAt: new Date(),
      },
    });
    this.logger.log(
      `JET Go onboarding submitted location=${args.locationId} reference=${referenceId} name="${collectPointName} (${locationName})"`,
    );

    // JET sometimes has it ready immediately. Worth one look so the common case
    // finishes in a single click.
    const resolved = await this.resolve({ locationId: args.locationId, tenantId: args.tenantId });
    return { referenceId, status: resolved.collectPointId ? "COMPLETE" : "PENDING", ...resolved };
  }

  /**
   * Find the collect point JET created for this location and store its id.
   *
   * Matching is by `corporateIdentifier` — the location id we sent. The name
   * is only a fallback, and deliberately a strict one: picking the wrong
   * collect point would send this shop's deliveries from another shop's door.
   */
  async resolve(args: { locationId: string; tenantId: string }) {
    const { location, cfg } = await this.load(args.locationId, args.tenantId);
    let points = [] as Awaited<ReturnType<JetGoClientService["collectPoints"]>>;
    try {
      points = await this.client.collectPoints(cfg);
    } catch (err: any) {
      throw new BadRequestException(
        `Couldn't read your JET Go collect points: ${String(err?.message ?? err).split(/→ \d+: /).pop()?.trim()}`,
      );
    }

    let match = points.find(
      (p: any) => this.str(p.corporateIdentifier) === this.str(args.locationId),
    );
    if (!match) {
      const { collectPointName, locationName } = this.names(location);
      const wanted = `${collectPointName} (${locationName})`.toLowerCase();
      const postcode = this.str(location.postcode).replace(/\s+/g, "").toLowerCase();
      const byName = points.filter((p: any) => {
        const name = this.str(p.name).toLowerCase();
        const short = this.str(p.shortName).toLowerCase();
        return name === wanted || (short === collectPointName.toLowerCase() && name.includes(locationName.toLowerCase()));
      });
      // Only accept a name match when it is unambiguous AND the postcode agrees.
      if (byName.length === 1 && postcode) {
        const theirs = this.str((byName[0] as any).postalCode).replace(/\s+/g, "").toLowerCase();
        if (theirs && theirs === postcode) match = byName[0];
      }
    }

    if (!match) {
      return {
        collectPointId: cfg.collectPointId ?? null,
        collectPointName: cfg.collectPointName ?? null,
        pending: true,
        candidates: points.length,
      };
    }

    await this.db().jetGoConfig.update({
      where: { locationId: args.locationId },
      data: {
        collectPointId: match.id,
        collectPointName: this.str(match.name) || this.str(match.shortName) || null,
        onboardingStatus: "COMPLETE",
        onboardingError: null,
      },
    });
    this.logger.log(
      `JET Go collect point resolved location=${args.locationId} → ${match.id} ("${match.name ?? match.shortName ?? "?"}")`,
    );
    return {
      collectPointId: match.id,
      collectPointName: this.str(match.name) || this.str(match.shortName) || null,
      pending: false,
      candidates: points.length,
    };
  }

  /** Push this location's current address/contact details onto its collect point. */
  async syncDetails(args: { locationId: string; tenantId: string; pickupInstructions?: string }) {
    const { location, cfg } = await this.load(args.locationId, args.tenantId);
    if (!cfg.collectPointId) {
      throw new BadRequestException(
        "This location has no JET Go collect point yet — register it first.",
      );
    }
    const { collectPointName, locationName } = this.names(location);
    const lat = Number(location.latitude);
    const lng = Number(location.longitude);
    const body: JetGoUpdateCollectPointBody = {
      collectPointName,
      locationName,
      ...(this.str(location.phone) ? { phoneNumber: this.str(location.phone) } : {}),
      ...(Number.isFinite(lat) && Number.isFinite(lng) ? { latitude: lat, longitude: lng } : {}),
      ...(this.str(location.addressLine1)
        ? {
            address: [this.str(location.addressLine1), this.str(location.addressLine2)]
              .filter(Boolean)
              .join(", "),
          }
        : {}),
      ...(this.str(location.city) ? { city: this.str(location.city) } : {}),
      ...(this.str(location.postcode) ? { postalCode: this.str(location.postcode) } : {}),
      country: this.country(location),
      corporateIdentifier: args.locationId,
      // Lower-case p, upper-case U. The POST spells it PickupInstructions.
      ...(this.str(args.pickupInstructions)
        ? { pickUpInstructions: this.str(args.pickupInstructions) }
        : {}),
    };
    try {
      await this.client.updateCollectPoint(cfg, cfg.collectPointId, body);
    } catch (err: any) {
      const detail = String(err?.message ?? err).split(/→ \d+: /).pop()?.trim();
      throw new BadRequestException(`JET Go refused the update: ${detail ?? "unknown error"}`);
    }
    await this.db().jetGoConfig.update({
      where: { locationId: args.locationId },
      data: { collectPointName: `${collectPointName} (${locationName})` },
    });
    this.logger.log(`JET Go collect point ${cfg.collectPointId} updated from location=${args.locationId}`);
    return { ok: true, collectPointId: cfg.collectPointId };
  }
}
