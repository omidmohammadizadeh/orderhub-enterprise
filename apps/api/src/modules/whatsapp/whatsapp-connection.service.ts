import { BadRequestException, Injectable, Logger, NotFoundException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { PrismaService } from "../../infrastructure/database/prisma.service";

// Phase AY (P6) — per-location WhatsApp activation. Platform-managed model:
// every restaurant's number lives under our single Meta app/WABA, so sending
// + webhook security use the shared platform token/app-secret (env). The only
// per-location data is the routing key (Phone Number ID) + the display number
// for the wa.me return link — both non-secret, stored in Integration.settings.

export interface WhatsAppConnectionDto {
  locationId: string;
  enabled: boolean;
  phoneNumberId: string;
  displayPhoneNumber?: string;
  wabaId?: string;
}

const GRAPH_VERSION = "v21.0";

@Injectable()
export class WhatsAppConnectionService {
  private readonly logger = new Logger(WhatsAppConnectionService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  private webhookUrl(): string {
    const base =
      this.config.get<string>("API_PUBLIC_URL") ??
      this.config.get<string>("PUBLIC_API_URL") ??
      "https://api.orderhubsolutions.com";
    return `${base.replace(/\/$/, "")}/api/v1/whatsapp/webhook`;
  }

  private async assertLocation(locationId: string, tenantId: string) {
    const loc = await this.prisma.location.findFirst({
      where: { id: locationId, brand: { tenantId } },
      select: { id: true },
    });
    if (!loc) throw new NotFoundException("Location not found");
  }

  /** Current WhatsApp connection for a location (+ the values to paste into Meta). */
  async getConnection(locationId: string, tenantId: string) {
    await this.assertLocation(locationId, tenantId);
    const integ = await this.prisma.integration.findUnique({
      where: { locationId_platform: { locationId, platform: "WHATSAPP" as any } },
      select: { status: true, settings: true, lastSyncAt: true, lastError: true },
    });
    const s = ((integ?.settings as any) ?? {}) as Record<string, string>;
    return {
      configured: !!integ,
      enabled: integ?.status === "ACTIVE",
      status: integ?.status ?? "NOT_CONFIGURED",
      phoneNumberId: s.phoneNumberId ?? "",
      displayPhoneNumber: s.displayPhoneNumber ?? "",
      wabaId: s.wabaId ?? "",
      verifiedName: s.verifiedName ?? null,
      lastTestedAt: integ?.lastSyncAt ?? null,
      lastError: integ?.lastError ?? null,
      // Values the operator pastes into the Meta dashboard:
      webhookUrl: this.webhookUrl(),
      verifyToken: this.config.get<string>("WHATSAPP_VERIFY_TOKEN") ?? "",
    };
  }

  /** Create / update the connection. status ACTIVE only when enabled + a number is set. */
  async saveConnection(tenantId: string, dto: WhatsAppConnectionDto) {
    await this.assertLocation(dto.locationId, tenantId);
    const phoneNumberId = (dto.phoneNumberId ?? "").trim();
    const displayPhoneNumber = (dto.displayPhoneNumber ?? "").trim();
    const wabaId = (dto.wabaId ?? "").trim();

    if (dto.enabled && !phoneNumberId) {
      throw new BadRequestException("A Phone Number ID is required to enable WhatsApp ordering.");
    }
    // Guard against two locations claiming the same number.
    if (phoneNumberId) {
      const clash = await this.prisma.integration.findFirst({
        where: {
          platform: "WHATSAPP" as any,
          deletedAt: null,
          locationId: { not: dto.locationId },
          settings: { path: ["phoneNumberId"], equals: phoneNumberId },
        },
        select: { locationId: true },
      });
      if (clash) {
        throw new BadRequestException(
          "That Phone Number ID is already connected to another location.",
        );
      }
    }

    const status = dto.enabled && phoneNumberId ? "ACTIVE" : "INACTIVE";
    const settings: Record<string, string> = { phoneNumberId, displayPhoneNumber };
    if (wabaId) settings.wabaId = wabaId;

    await this.prisma.integration.upsert({
      where: { locationId_platform: { locationId: dto.locationId, platform: "WHATSAPP" as any } },
      create: {
        tenantId,
        locationId: dto.locationId,
        platform: "WHATSAPP" as any,
        status: status as any,
        credentials: {},
        settings: settings as any,
        webhookUrl: this.webhookUrl(),
      },
      update: {
        status: status as any,
        // Merge so a Test-connection-set verifiedName isn't wiped on a plain save.
        settings: settings as any,
        webhookUrl: this.webhookUrl(),
        deletedAt: null,
      },
    });
    return this.getConnection(dto.locationId, tenantId);
  }

  /** Validate the number against Meta using the shared platform token. */
  async testConnection(locationId: string, tenantId: string) {
    await this.assertLocation(locationId, tenantId);
    const integ = await this.prisma.integration.findUnique({
      where: { locationId_platform: { locationId, platform: "WHATSAPP" as any } },
      select: { settings: true },
    });
    const s = ((integ?.settings as any) ?? {}) as Record<string, string>;
    const phoneNumberId = s.phoneNumberId;
    if (!phoneNumberId) {
      throw new BadRequestException("Add a Phone Number ID and save before testing.");
    }
    const token = this.config.get<string>("WHATSAPP_ACCESS_TOKEN");
    if (!token) {
      throw new BadRequestException("The platform WhatsApp token isn't configured on the server.");
    }

    let json: any;
    try {
      const res = await fetch(
        `https://graph.facebook.com/${GRAPH_VERSION}/${phoneNumberId}?fields=display_phone_number,verified_name,quality_rating`,
        { headers: { Authorization: `Bearer ${token}` } },
      );
      json = await res.json();
      if (!res.ok) {
        const msg = json?.error?.message ?? `Meta returned ${res.status}`;
        await this.prisma.integration.update({
          where: { locationId_platform: { locationId, platform: "WHATSAPP" as any } },
          data: { lastErrorAt: new Date(), lastError: msg },
        });
        throw new BadRequestException(`WhatsApp test failed: ${msg}`);
      }
    } catch (err: any) {
      if (err instanceof BadRequestException) throw err;
      throw new BadRequestException(`Couldn't reach Meta: ${err?.message ?? err}`);
    }

    const verifiedName: string | undefined = json.verified_name;
    const displayPhoneNumber: string | undefined = json.display_phone_number;
    const merged: Record<string, string> = { ...s };
    if (verifiedName) merged.verifiedName = verifiedName;
    if (displayPhoneNumber && !merged.displayPhoneNumber) merged.displayPhoneNumber = displayPhoneNumber;

    await this.prisma.integration.update({
      where: { locationId_platform: { locationId, platform: "WHATSAPP" as any } },
      data: {
        settings: merged as any,
        lastSyncAt: new Date(),
        lastError: null,
        lastErrorAt: null,
      },
    });
    return {
      ok: true,
      verifiedName: verifiedName ?? null,
      displayPhoneNumber: displayPhoneNumber ?? null,
      qualityRating: json.quality_rating ?? null,
    };
  }
}
