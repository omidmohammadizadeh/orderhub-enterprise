import { Injectable, Logger } from "@nestjs/common";
import { PrismaService } from "../../infrastructure/database/prisma.service";
import {
  WhatsAppMenuService,
  type WaMenuContext,
} from "../whatsapp/whatsapp-menu.service";

// Which restaurant is this call for?
//
// The number that was DIALLED is the routing key — one Telnyx number per shop,
// stored on Location.settings.voiceNumber. That's also why each shop needs its
// own number even at $1/month: without it we cannot tell whose menu to load.
//
// The menu itself comes from WhatsAppMenuService, reused wholesale rather than
// copied. It already resolves serving assignments, variant pricing, item
// availability and modifier groups exactly the way the storefront and POS do —
// a second implementation would drift, and a phone line quoting a stale price
// is worse than one that doesn't answer.

export interface VoiceContext extends WaMenuContext {
  /** The Telnyx number that was dialled (E.164). */
  voiceNumber: string;
  /** Shown to the caller and used on the order. */
  locationPhone?: string | null;
  /** Where to send a call the AI can't handle. Usually the shop's own line. */
  transferNumber?: string | null;
  /** Operator kill switch — the AI answers only when this is on. */
  enabled: boolean;
  /** Answer without charging. For our own testing: a £1 debit per attempt
   *  makes tuning the conversation cost real money, and an empty wallet
   *  would stop the phone answering mid-session. */
  testMode: boolean;
  timezone?: string | null;
  openingHours?: unknown;
  address?: {
    line1?: string | null;
    city?: string | null;
    postcode?: string | null;
  };
  deliveryZones: Array<{ postcodePrefix: string; fee: number; minOrderValue: number | null }>;
  acceptsCash: boolean;
  acceptsCard: boolean;
  deliveryPrepMinutes: number;
  collectionPrepMinutes: number;
}

/** Digits only — the same number arrives as +447700900123, 447700900123 or
 *  07700 900123 depending on who is calling and how it was typed in. */
export function normaliseNumber(raw?: string | null): string {
  if (!raw) return "";
  const digits = String(raw).replace(/\D/g, "");
  // UK national → international, so 07700… and +447700… compare equal.
  if (digits.startsWith("0") && digits.length === 11) return `44${digits.slice(1)}`;
  return digits;
}

@Injectable()
export class VoiceContextService {
  private readonly logger = new Logger(VoiceContextService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly menus: WhatsAppMenuService,
  ) {}

  private db(): any {
    return this.prisma as any;
  }

  /**
   * Find the location whose AI line was dialled. Returns null when the number
   * isn't ours or isn't assigned — the caller then declines the call, which
   * simply leaves it ringing at whatever the carrier does next.
   */
  async locationForNumber(dialled: string): Promise<any | null> {
    const wanted = normaliseNumber(dialled);
    if (!wanted) return null;

    // Postgres JSON path equality on the stored value first (cheap, indexed by
    // the settings column), then a normalised sweep so a shop that typed the
    // number with spaces or a leading 0 still resolves.
    const exact = await this.db().location.findFirst({
      where: {
        deletedAt: null,
        isActive: true,
        settings: { path: ["voiceNumber"], equals: dialled },
      },
    });
    if (exact) return exact;

    const candidates = await this.db().location.findMany({
      where: { deletedAt: null, isActive: true, NOT: { settings: { equals: null } } },
      select: { id: true, settings: true },
    });
    const hit = candidates.find(
      (l: any) => normaliseNumber(l?.settings?.voiceNumber) === wanted,
    );
    if (!hit) return null;
    return this.db().location.findUnique({ where: { id: hit.id } });
  }

  /** Full context for a call: menu, hours, zones, transfer target, kill switch. */
  async resolve(dialled: string): Promise<VoiceContext | null> {
    const location = await this.locationForNumber(dialled);
    if (!location) {
      this.logger.warn(`No location owns voice number ${dialled}`);
      return null;
    }

    const settings = (location.settings ?? {}) as any;
    // PHONE channel: falls through to the location's active menu when the shop
    // has never published specifically to phone, which is the common case.
    const menuCtx = await this.menus.resolveContext(undefined, {
      locationIdOverride: location.id,
      channel: "PHONE",
    });
    if (!menuCtx) {
      this.logger.warn(`No active menu for location ${location.id} — AI cannot take orders`);
      return null;
    }

    const zones = await this.db().deliveryZone.findMany({
      where: { locationId: location.id },
      select: { postcodePrefix: true, fee: true, minOrderValue: true },
    });

    const direct = (location.directOrderingConfig ?? {}) as any;

    return {
      ...menuCtx,
      voiceNumber: dialled,
      locationPhone: location.phone ?? null,
      // Where an escalation goes. Falls back to the shop's own published
      // number, which is almost always right.
      transferNumber: settings.voiceTransferNumber ?? location.phone ?? null,
      // Default OFF. An AI that starts answering a restaurant's phone because
      // a number got assigned is not a feature.
      enabled: settings.voiceAiEnabled === true,
      testMode: settings.voiceTestMode === true,
      timezone: location.timezone ?? null,
      openingHours: location.openingHours ?? null,
      address: {
        line1: location.addressLine1 ?? null,
        city: location.city ?? null,
        postcode: location.postcode ?? null,
      },
      deliveryZones: zones.map((z: any) => ({
        postcodePrefix: String(z.postcodePrefix ?? ""),
        fee: Number(z.fee ?? 0),
        minOrderValue: z.minOrderValue != null ? Number(z.minOrderValue) : null,
      })),
      acceptsCash: direct.acceptsCash !== false,
      acceptsCard: direct.acceptsCard !== false,
      deliveryPrepMinutes: Number(direct.deliveryPrepMinutes ?? 45),
      collectionPrepMinutes: Number(direct.collectionPrepMinutes ?? 20),
    };
  }
}
