import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from "@nestjs/common";
import { PrismaService } from "../../infrastructure/database/prisma.service";
import {
  TABLET_ANALYTICS_PERMISSION,
  TABLET_ROLE,
} from "../../common/access/tablet-login";
import type { AuthenticatedUser } from "../auth/interfaces/jwt-payload.interface";

/**
 * What a shop's counter tablet may see on Analytics — and nothing for anyone
 * else: every other role returns straight away, so this changes nothing for
 * people who sign in as themselves.
 *
 * Three rules for the tablet:
 *   1. Only when the owner has switched Analytics on for that tablet login.
 *      Read from the database, not the token, so switching it off bites now.
 *   2. Only the reports the Analytics page actually draws. Overview scopes
 *      itself to the caller's locations; the rest of this controller trusts a
 *      locationId that may be left out, which would mean the whole tenant.
 *   3. Walk-in and dine-in must name a location — DeviceLocationGuard has
 *      already refused any location that isn't the tablet's own.
 */
const OVERVIEW_SCOPED = new Set(["getOverview"]);
const NEEDS_LOCATION = new Set(["getWalkInReport", "getDineInReport"]);

@Injectable()
export class TabletAnalyticsGuard implements CanActivate {
  constructor(private readonly prisma: PrismaService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest();
    const user = req.user as AuthenticatedUser | undefined;
    if (!user || String(user.role) !== TABLET_ROLE) return true;

    const handler = context.getHandler().name;
    if (!OVERVIEW_SCOPED.has(handler) && !NEEDS_LOCATION.has(handler)) {
      throw new ForbiddenException("Not available on the shop tablet");
    }
    if (NEEDS_LOCATION.has(handler) && !req.query?.locationId) {
      throw new ForbiddenException("Pick this shop's location first");
    }

    const row = await this.prisma.user.findUnique({
      where: { id: user.userId },
      select: { permissions: true, isActive: true },
    });
    if (!row?.isActive || !row.permissions.includes(TABLET_ANALYTICS_PERMISSION)) {
      throw new ForbiddenException(
        "Analytics is switched off for this tablet. An owner can turn it on in Team → Tablet logins.",
      );
    }
    return true;
  }
}
