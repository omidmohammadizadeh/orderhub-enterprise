// Team → Tablet logins.
//
// One shared sign-in per shop for the counter tablet, modelled on Uber Eats
// Order Manager: a generated username, a password the owner sets and can reset
// at any time, and access to the shop-floor tabs of that ONE location only.
//
// It sits beside the existing setup rather than replacing it. Staff who sign
// in as themselves keep doing so; a shop that never creates a tablet login
// sees no difference anywhere.

import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import * as crypto from "crypto";
import * as bcrypt from "bcryptjs";
import { PrismaService } from "../../infrastructure/database/prisma.service";
import { LocationAccessService } from "../../common/access/location-access.service";
import {
  TABLET_ANALYTICS_PERMISSION,
  TABLET_ROLE,
  tabletEmailFor,
  tabletPasswordProblem,
  tabletUsernameFromEmail,
} from "../../common/access/tablet-login";
import type { AuthenticatedUser } from "../auth/interfaces/jwt-payload.interface";

export interface TabletLoginView {
  userId: string;
  username: string;
  isActive: boolean;
  analytics: boolean;
  lastLoginAt: Date | null;
  createdAt: Date;
}

export interface TabletLoginRow {
  locationId: string;
  locationName: string;
  brandName: string | null;
  login: TabletLoginView | null;
}

/**
 * "Monster Burgerz", "High St" → "monster-burgerz-high-st". Long enough (32)
 * to keep the branch's own words, so two shops of one brand don't look alike.
 */
export function usernameStem(brandName: string | null, locationName: string): string {
  const words = `${brandName ?? ""} ${locationName}`
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  // Location names often repeat the brand ("Monster Burgerz - High St").
  const unique = words.filter((w, i) => words.indexOf(w) === i);
  let stem = "";
  for (const w of unique) {
    const next = stem ? `${stem}-${w}` : w;
    if (next.length > 32) break;
    stem = next;
  }
  return stem || "shop";
}

@Injectable()
export class TabletLoginsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: LocationAccessService,
  ) {}

  async list(caller: AuthenticatedUser): Promise<TabletLoginRow[]> {
    const ids = await this.access.accessibleIds(caller);
    if (ids.length === 0) return [];

    const locations = await this.prisma.location.findMany({
      where: { id: { in: ids }, brand: { tenantId: caller.tenantId }, deletedAt: null },
      select: { id: true, name: true, brand: { select: { name: true } } },
      orderBy: { name: "asc" },
    });
    const tablets = await this.prisma.user.findMany({
      where: {
        tenantId: caller.tenantId,
        role: TABLET_ROLE as any,
        locations: { some: { locationId: { in: locations.map((l) => l.id) } } },
      },
      select: {
        id: true,
        email: true,
        isActive: true,
        permissions: true,
        lastLoginAt: true,
        createdAt: true,
        locations: { select: { locationId: true } },
      },
    });

    return locations.map((loc) => {
      const user = tablets.find((t) =>
        t.locations.some((l) => l.locationId === loc.id),
      );
      return {
        locationId: loc.id,
        locationName: loc.name,
        brandName: loc.brand?.name ?? null,
        login: user ? this.view(user) : null,
      };
    });
  }

  async create(
    caller: AuthenticatedUser,
    locationId: string,
    password: unknown,
  ): Promise<TabletLoginView> {
    const problem = tabletPasswordProblem(password);
    if (problem) throw new BadRequestException(problem);
    const location = await this.assertLocation(caller, locationId);

    if (await this.findTablet(caller.tenantId, locationId)) {
      throw new ConflictException(
        "This shop already has a tablet login — reset its password instead",
      );
    }

    const stem = usernameStem(location.brand?.name ?? null, location.name);
    const hashed = await bcrypt.hash(password as string, 12);

    // Five random digits keep usernames unguessable from the shop name alone
    // and make a collision rare; retry on the odd one that does collide.
    for (let attempt = 0; attempt < 5; attempt++) {
      const username = `${stem}-${crypto.randomInt(10000, 100000)}`;
      const email = tabletEmailFor(username);
      if (await this.prisma.user.findUnique({ where: { email }, select: { id: true } })) {
        continue;
      }
      const user = await this.prisma.user.create({
        data: {
          tenantId: caller.tenantId,
          email,
          password: hashed,
          firstName: location.name,
          lastName: "Tablet",
          role: TABLET_ROLE as any,
          isActive: true,
          isVerified: true,
          permissions: [],
          locations: { create: { locationId } },
        },
        select: {
          id: true,
          email: true,
          isActive: true,
          permissions: true,
          lastLoginAt: true,
          createdAt: true,
        },
      });
      return this.view(user);
    }
    throw new ConflictException("Could not generate a free username — try again");
  }

  /** New password, and every tablet signed in with the old one is signed out. */
  async resetPassword(
    caller: AuthenticatedUser,
    locationId: string,
    password: unknown,
  ): Promise<TabletLoginView> {
    const problem = tabletPasswordProblem(password);
    if (problem) throw new BadRequestException(problem);
    await this.assertLocation(caller, locationId);
    const tablet = await this.requireTablet(caller.tenantId, locationId);

    const hashed = await bcrypt.hash(password as string, 12);
    const [user] = await this.prisma.$transaction([
      this.prisma.user.update({
        where: { id: tablet.id },
        data: { password: hashed },
        select: {
          id: true,
          email: true,
          isActive: true,
          permissions: true,
          lastLoginAt: true,
          createdAt: true,
        },
      }),
      // Deleted rather than revoked: a revoked token replayed within the
      // refresh grace window still earns a fresh pair, and a reset has to
      // actually sign the old tablets out.
      this.prisma.refreshToken.deleteMany({ where: { userId: tablet.id } }),
    ]);
    return this.view(user);
  }

  async update(
    caller: AuthenticatedUser,
    locationId: string,
    body: { analytics?: unknown; isActive?: unknown },
  ): Promise<TabletLoginView> {
    await this.assertLocation(caller, locationId);
    const tablet = await this.requireTablet(caller.tenantId, locationId);

    const data: { permissions?: string[]; isActive?: boolean } = {};
    if (typeof body.analytics === "boolean") {
      const rest = tablet.permissions.filter((p) => p !== TABLET_ANALYTICS_PERMISSION);
      data.permissions = body.analytics ? [...rest, TABLET_ANALYTICS_PERMISSION] : rest;
    }
    if (typeof body.isActive === "boolean") data.isActive = body.isActive;
    if (Object.keys(data).length === 0) {
      throw new BadRequestException("Nothing to change");
    }

    const [user] = await this.prisma.$transaction([
      this.prisma.user.update({
        where: { id: tablet.id },
        data,
        select: {
          id: true,
          email: true,
          isActive: true,
          permissions: true,
          lastLoginAt: true,
          createdAt: true,
        },
      }),
      // Switching the login off signs its tablets out now, not at next refresh.
      ...(data.isActive === false
        ? [this.prisma.refreshToken.deleteMany({ where: { userId: tablet.id } })]
        : []),
    ]);
    return this.view(user);
  }

  async remove(caller: AuthenticatedUser, locationId: string): Promise<void> {
    await this.assertLocation(caller, locationId);
    const tablet = await this.requireTablet(caller.tenantId, locationId);
    // Orders keep the user id they were taken under, so the account is
    // retired rather than deleted; its tokens go so no tablet stays in.
    await this.prisma.$transaction([
      this.prisma.refreshToken.deleteMany({ where: { userId: tablet.id } }),
      this.prisma.userLocation.deleteMany({ where: { userId: tablet.id } }),
      this.prisma.user.update({
        where: { id: tablet.id },
        data: { isActive: false },
      }),
    ]);
  }

  // ── helpers ──────────────────────────────────────────────────────────

  private async assertLocation(caller: AuthenticatedUser, locationId: string) {
    const location = await this.prisma.location.findFirst({
      where: { id: locationId, brand: { tenantId: caller.tenantId }, deletedAt: null },
      select: { id: true, name: true, brand: { select: { name: true } } },
    });
    if (!location) throw new NotFoundException("Location not found");
    try {
      await this.access.assertAccess(caller, locationId);
    } catch {
      throw new ForbiddenException("You don't manage this location");
    }
    return location;
  }

  private findTablet(tenantId: string, locationId: string) {
    return this.prisma.user.findFirst({
      where: {
        tenantId,
        role: TABLET_ROLE as any,
        locations: { some: { locationId } },
      },
      select: { id: true, permissions: true },
    });
  }

  private async requireTablet(tenantId: string, locationId: string) {
    const tablet = await this.findTablet(tenantId, locationId);
    if (!tablet) throw new NotFoundException("This shop has no tablet login yet");
    return tablet;
  }

  private view(user: {
    id: string;
    email: string;
    isActive: boolean;
    permissions: string[];
    lastLoginAt: Date | null;
    createdAt: Date;
  }): TabletLoginView {
    return {
      userId: user.id,
      username: tabletUsernameFromEmail(user.email),
      isActive: user.isActive,
      analytics: user.permissions.includes(TABLET_ANALYTICS_PERMISSION),
      lastLoginAt: user.lastLoginAt,
      createdAt: user.createdAt,
    };
  }
}
