// Phase BK — per-location Yango Delivery config (encrypted token).
//
// Mirrors JetGoConfigService, with the things Yango forces on us:
//
//   • mode — "estimate_only" by default. Yango has no sandbox: accepting a claim
//     sends a real courier and bills the shop. Going live needs an explicit
//     acknowledgement in the request, not just a changed dropdown.
//   • a stored PICKUP POINT. Yango takes coordinates, Location has none, so the
//     shop address is geocoded once here (and can be corrected by hand) rather
//     than re-geocoded on every dispatch.
//   • contactEmail — Yango requires an email on the pickup contact.
//   • UAE only. Yango's express API is the same everywhere, but nobody has
//     confirmed Yango Delivery trades for us anywhere else, so a location
//     outside YANGO_COUNTRIES cannot be set up at all.

import { BadRequestException, Injectable, NotFoundException, Optional } from "@nestjs/common";
import { randomBytes } from "crypto";
import { resolveCountryCode } from "@orderhub/shared";
import { PrismaService } from "../../../infrastructure/database/prisma.service";
import { CredentialEncryptionService } from "../credential-encryption.service";
import { GeocodingService } from "../../dispatch/geocoding.service";
import type { YangoCreds } from "./yango-client.service";

/** Where we offer Yango dispatch. Extend only with Yango's confirmation. */
export const YANGO_COUNTRIES = ["AE"];

export const YANGO_TAXI_CLASSES = ["courier", "express"] as const;
export const YANGO_MODES = ["estimate_only", "live"] as const;

export interface DecryptedYangoConfig extends YangoCreds {
  tenantId: string;
  locationId: string;
  mode: string;
  taxiClass: string;
  contactEmail: string | null;
  pickupLat: number | null;
  pickupLng: number | null;
  webhookToken: string;
  active: boolean;
}

export function yangoCountrySupported(country: string | null | undefined): boolean {
  return YANGO_COUNTRIES.includes(resolveCountryCode(country));
}

function validCoord(lat: unknown, lng: unknown): boolean {
  const a = Number(lat);
  const b = Number(lng);
  return (
    Number.isFinite(a) &&
    Number.isFinite(b) &&
    Math.abs(a) <= 90 &&
    Math.abs(b) <= 180 &&
    !(a === 0 && b === 0)
  );
}

@Injectable()
export class YangoConfigService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly encryption: CredentialEncryptionService,
    @Optional() private readonly geocoding?: GeocodingService,
  ) {}

  private db(): any {
    return this.prisma as any;
  }

  private async loadLocation(locationId: string, tenantId: string) {
    const loc = await this.prisma.location.findFirst({
      where: { id: locationId, deletedAt: null, brand: { tenantId } },
      select: {
        id: true,
        name: true,
        country: true,
        addressLine1: true,
        addressLine2: true,
        city: true,
        postcode: true,
      },
    });
    if (!loc) throw new NotFoundException("Location not found");
    return loc as any;
  }

  /** Where Yango POSTs its (deprecated, unsigned) callback. Yango CONCATENATES
   *  `updated_ts=…&claim_id=…` onto this string rather than merging query
   *  params, so it must end in "?" — without it the result would be
   *  ".../TOKENupdated_ts=…". */
  webhookUrl(apiBaseUrl: string, token: string): string {
    return `${apiBaseUrl.replace(/\/$/, "")}/api/v1/webhooks/yango/${token}?`;
  }

  async getPublicConfig(locationId: string, tenantId: string, apiBaseUrl: string) {
    const loc = await this.loadLocation(locationId, tenantId);
    const countrySupported = yangoCountrySupported(loc.country);
    const row = await this.db().yangoConfig.findUnique({ where: { locationId } });
    if (!row) {
      return {
        configured: false,
        active: false,
        countrySupported,
        mode: "estimate_only",
        taxiClass: "courier",
        contactEmail: null,
        pickupLat: null,
        pickupLng: null,
        tokenMasked: null,
        webhookUrl: null,
        canQuote: false,
        readyToDispatch: false,
      };
    }
    let token = "";
    try {
      token = String((this.encryption.decrypt(row.credentials) as any)?.token ?? "");
    } catch {
      token = "";
    }
    const hasPickup = validCoord(row.pickupLat, row.pickupLng);
    const canQuote = Boolean(row.active && token && hasPickup && countrySupported);
    return {
      configured: true,
      active: row.active,
      countrySupported,
      mode: row.mode,
      taxiClass: row.taxiClass,
      contactEmail: row.contactEmail,
      pickupLat: row.pickupLat,
      pickupLng: row.pickupLng,
      tokenMasked: token ? `${token.slice(0, 4)}…${token.slice(-4)}` : null,
      webhookUrl: this.webhookUrl(apiBaseUrl, row.webhookToken),
      /** Quotes work in both modes. */
      canQuote,
      /** Only live mode books couriers. */
      readyToDispatch: canQuote && row.mode === "live",
    };
  }

  async upsert(
    locationId: string,
    tenantId: string,
    dto: {
      token?: string;
      mode?: string;
      acknowledgeLiveCouriers?: boolean;
      taxiClass?: string;
      contactEmail?: string;
      pickupLat?: number | null;
      pickupLng?: number | null;
    },
  ) {
    const loc = await this.loadLocation(locationId, tenantId);
    if (!yangoCountrySupported(loc.country)) {
      throw new BadRequestException(
        `Yango Delivery is only available for shops in the UAE. This location is set to ${loc.country || "no country"}.`,
      );
    }
    const existing = await this.db().yangoConfig.findUnique({ where: { locationId } });

    let token = (dto.token ?? "").trim();
    if (!token && existing) {
      try {
        token = String((this.encryption.decrypt(existing.credentials) as any)?.token ?? "");
      } catch {
        token = "";
      }
    }
    if (!token) {
      throw new BadRequestException(
        "Paste the API token from your Yango business cabinet → Integration → Get token.",
      );
    }
    // A token with whitespace inside is a bad paste (a wrapped line), not a token.
    if (/\s/.test(token)) {
      throw new BadRequestException("That token has spaces in it — copy it again in one piece.");
    }

    const mode = YANGO_MODES.includes(dto.mode as any)
      ? String(dto.mode)
      : (existing?.mode ?? "estimate_only");
    // Switching INTO live is the moment real money starts moving. It has to be
    // asked for in so many words, so a stale form or a default can't do it.
    if (mode === "live" && existing?.mode !== "live" && dto.acknowledgeLiveCouriers !== true) {
      throw new BadRequestException(
        "Going live means every dispatch books a real Yango courier and bills your Yango account. Confirm that to switch to live.",
      );
    }

    const taxiClass = YANGO_TAXI_CLASSES.includes(dto.taxiClass as any)
      ? String(dto.taxiClass)
      : (existing?.taxiClass ?? "courier");

    const contactEmail =
      dto.contactEmail !== undefined ? dto.contactEmail.trim() || null : (existing?.contactEmail ?? null);
    if (contactEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contactEmail)) {
      throw new BadRequestException("That contact email doesn't look right.");
    }

    // Pickup point: an explicit pair wins; otherwise keep what we have; otherwise
    // geocode the shop's address once.
    let pickupLat: number | null = existing?.pickupLat ?? null;
    let pickupLng: number | null = existing?.pickupLng ?? null;
    let geocoded = false;
    if (dto.pickupLat != null || dto.pickupLng != null) {
      if (!validCoord(dto.pickupLat, dto.pickupLng)) {
        throw new BadRequestException(
          "The pickup latitude/longitude aren't valid. In Dubai they look like 25.2 / 55.3.",
        );
      }
      pickupLat = Number(dto.pickupLat);
      pickupLng = Number(dto.pickupLng);
    } else if (!validCoord(pickupLat, pickupLng) && this.geocoding) {
      const addr = [loc.addressLine1, loc.addressLine2, loc.city, loc.postcode]
        .filter(Boolean)
        .join(", ");
      const point = addr ? await this.geocoding.geocode(addr, "AE") : null;
      if (point) {
        pickupLat = point.lat;
        pickupLng = point.lng;
        geocoded = true;
      }
    }

    const credentials = this.encryption.encrypt({ token });
    const data = { mode, taxiClass, contactEmail, pickupLat, pickupLng, credentials };
    await this.db().yangoConfig.upsert({
      where: { locationId },
      create: {
        tenantId,
        locationId,
        webhookToken: randomBytes(24).toString("hex"),
        ...data,
      },
      update: data,
    });
    return {
      ok: true,
      mode,
      geocodedPickup: geocoded,
      pickupMissing: !validCoord(pickupLat, pickupLng),
    };
  }

  async setActive(locationId: string, tenantId: string, active: boolean) {
    const loc = await this.loadLocation(locationId, tenantId);
    const row = await this.db().yangoConfig.findUnique({
      where: { locationId },
      select: { id: true, pickupLat: true, pickupLng: true, contactEmail: true },
    });
    if (!row) {
      throw new BadRequestException("Add your Yango API token before activating.");
    }
    if (active) {
      if (!yangoCountrySupported(loc.country)) {
        throw new BadRequestException("Yango Delivery is only available for shops in the UAE.");
      }
      if (!validCoord(row.pickupLat, row.pickupLng)) {
        throw new BadRequestException(
          "Set this shop's pickup point first — Yango needs the courier's pickup coordinates.",
        );
      }
      if (!row.contactEmail) {
        throw new BadRequestException(
          "Add a contact email first — Yango requires one on the pickup point.",
        );
      }
    }
    await this.db().yangoConfig.update({ where: { locationId }, data: { active } });
    return { ok: true, active };
  }

  async getDecrypted(locationId: string | null | undefined): Promise<DecryptedYangoConfig | null> {
    if (!locationId) return null;
    const row = await this.db().yangoConfig.findUnique({ where: { locationId } });
    return row ? this.toDecrypted(row) : null;
  }

  async findByWebhookToken(token: string): Promise<DecryptedYangoConfig | null> {
    const t = (token ?? "").trim();
    if (!t) return null;
    const row = await this.db().yangoConfig.findFirst({ where: { webhookToken: t } });
    return row ? this.toDecrypted(row) : null;
  }

  toDecrypted(row: any): DecryptedYangoConfig {
    let creds: any = {};
    try {
      creds = this.encryption.decrypt(row.credentials) ?? {};
    } catch {
      creds = {};
    }
    return {
      tenantId: row.tenantId,
      locationId: row.locationId,
      token: String(creds?.token ?? ""),
      mode: row.mode,
      taxiClass: row.taxiClass,
      contactEmail: row.contactEmail ?? null,
      pickupLat: row.pickupLat ?? null,
      pickupLng: row.pickupLng ?? null,
      webhookToken: row.webhookToken,
      active: row.active,
    };
  }
}
