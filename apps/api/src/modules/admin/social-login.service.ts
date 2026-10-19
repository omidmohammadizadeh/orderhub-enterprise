import { BadRequestException, Injectable, Logger, NotFoundException } from "@nestjs/common";
import { PrismaService } from "../../infrastructure/database/prisma.service";

// ── Social login (Admin Dashboard → Social login) ──────────────────────────
//
// Which sign-in buttons each restaurant's own app shows (apps/customer):
// Sign in with Apple and Google on iOS, Google on Android. Stored on
// Brand.settings.socialLogin and read by the app at launch, so the platform
// team decides per app, and per store submission, without a new build.
//
// Off until switched on: an app submitted without social sign-in must not grow
// the buttons because a brand row exists. The build still has to carry the
// native pieces (a Google client id, the Apple capability) for a button to
// appear — this only ever hides what the build could show.
//
// App Store guideline 4.8: an iOS app offering Google must offer Sign in with
// Apple too, so iOS Google can't be on without iOS Apple.

export interface SocialLoginFlags {
  ios: { apple: boolean; google: boolean };
  android: { google: boolean };
}

export interface SocialLoginAdminRow extends SocialLoginFlags {
  brandId: string;
  brandName: string;
  tenantName: string;
  logoUrl: string | null;
  /** Bundle ids of this brand's native apps seen registering for push. */
  appIds: string[];
}

export const SOCIAL_LOGIN_OFF: SocialLoginFlags = {
  ios: { apple: false, google: false },
  android: { google: false },
};

/** Anything stored (or nothing) → a complete, valid set of flags. */
export function readSocialLogin(settings: unknown): SocialLoginFlags {
  const raw = (settings as { socialLogin?: any } | null)?.socialLogin;
  const apple = raw?.ios?.apple === true;
  return {
    // Re-applied on read so a hand-edited row can't break the rule either.
    ios: { apple, google: apple && raw?.ios?.google === true },
    android: { google: raw?.android?.google === true },
  };
}

type BrandRow = {
  id: string;
  name: string;
  logoUrl: string | null;
  settings: unknown;
  tenant: { name: string };
  locations: { logoUrl: string | null }[];
};

const BRAND_SELECT = {
  id: true,
  name: true,
  logoUrl: true,
  settings: true,
  tenant: { select: { name: true } },
  locations: { where: { deletedAt: null }, select: { logoUrl: true }, take: 3 },
} as const;

@Injectable()
export class SocialLoginService {
  private readonly logger = new Logger(SocialLoginService.name);

  constructor(private readonly prisma: PrismaService) {}

  private async appIdsByBrand(): Promise<Map<string, string[]>> {
    const rows = await (this.prisma as any).customerPushSubscription.groupBy({
      by: ["brandId", "appId"],
      where: { kind: { not: "WEB" }, brandId: { not: null }, appId: { not: null } },
    });
    const out = new Map<string, string[]>();
    for (const r of rows as { brandId: string; appId: string }[]) {
      out.set(r.brandId, [...(out.get(r.brandId) ?? []), r.appId]);
    }
    return out;
  }

  private toRow(b: BrandRow, apps: Map<string, string[]>): SocialLoginAdminRow {
    return {
      brandId: b.id,
      brandName: b.name,
      tenantName: b.tenant.name,
      logoUrl: b.logoUrl?.trim() || b.locations.map((l) => l.logoUrl?.trim()).find(Boolean) || null,
      appIds: (apps.get(b.id) ?? []).sort(),
      ...readSocialLogin(b.settings),
    };
  }

  /** Every active brand: ones with an app or anything switched on first. */
  async list(): Promise<SocialLoginAdminRow[]> {
    const [brands, apps] = await Promise.all([
      this.prisma.brand.findMany({ where: { deletedAt: null, isActive: true }, select: BRAND_SELECT }),
      this.appIdsByBrand(),
    ]);
    const rank = (r: SocialLoginAdminRow) =>
      (r.ios.apple || r.ios.google || r.android.google ? 2 : 0) + (r.appIds.length ? 1 : 0);
    return (brands as BrandRow[])
      .map((b) => this.toRow(b, apps))
      .sort((a, b) => rank(b) - rank(a) || a.brandName.localeCompare(b.brandName));
  }

  async set(brandId: string, flags: SocialLoginFlags, actorId?: string): Promise<SocialLoginAdminRow> {
    if (flags.ios.google && !flags.ios.apple) {
      throw new BadRequestException(
        "Turn on Sign in with Apple for iOS too — Apple requires it whenever Google sign-in is offered (guideline 4.8).",
      );
    }
    const brand = await this.prisma.brand.findFirst({
      where: { id: brandId, deletedAt: null },
      select: { settings: true },
    });
    if (!brand) throw new NotFoundException("Brand not found");
    const settings = {
      ...((brand.settings as Record<string, unknown> | null) ?? {}),
      socialLogin: readSocialLogin({ socialLogin: flags }),
    };
    const b = await this.prisma.brand.update({
      where: { id: brandId },
      data: { settings: settings as any },
      select: BRAND_SELECT,
    });
    this.logger.log(
      `Social login for brand ${brandId} by ${actorId ?? "?"}: ${JSON.stringify(settings.socialLogin)}`,
    );
    return this.toRow(b as BrandRow, await this.appIdsByBrand());
  }

  /** What the app reads at launch. Unknown brand → everything off. */
  async forApp(brandId: string): Promise<SocialLoginFlags> {
    const brand = await this.prisma.brand.findFirst({
      where: { id: brandId, deletedAt: null },
      select: { settings: true },
    });
    return brand ? readSocialLogin(brand.settings) : SOCIAL_LOGIN_OFF;
  }
}
