import {
  Injectable,
  CanActivate,
  ExecutionContext,
  ForbiddenException,
} from "@nestjs/common";
import { PrismaService } from "../../infrastructure/database/prisma.service";
import type { AuthenticatedUser } from "../../modules/auth/interfaces/jwt-payload.interface";

/**
 * Pins a DEVICE account to the location it was assigned to.
 *
 * A kiosk tablet in a doorway and a display screwed to a kitchen wall each
 * sign in as their own user, and they stay signed in for months. That token
 * is the easiest credential in the business to get hold of — the device is
 * unattended, often unlocked, and nobody notices a stranger tapping it.
 *
 * Roles alone don't contain that: a KITCHEN_DISPLAY at the Pelton branch
 * still carries a valid tenant token, so without this it could ask for
 * Chester-le-Street's screens and tickets simply by changing an id in the
 * URL. Every location in the tenant would be one edited request away.
 *
 * So for device roles ONLY, this resolves whatever location the request is
 * reaching for and requires it to be one the device is assigned to.
 *
 * It is deliberately a global guard rather than a per-endpoint check. The KDS
 * and kiosk surfaces will grow more endpoints, and a rule you have to
 * remember to apply is a rule that eventually isn't. Real users are untouched
 * — the guard returns immediately for any role that isn't a device.
 */

/** Roles that are hardware, not people. */
const DEVICE_ROLES = new Set(["KIOSK", "KITCHEN_DISPLAY"]);

@Injectable()
export class DeviceLocationGuard implements CanActivate {
  constructor(private readonly prisma: PrismaService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest();
    const user = req.user as AuthenticatedUser | undefined;

    // Not a device (or not authenticated yet — JwtAuthGuard's problem).
    if (!user || !DEVICE_ROLES.has(user.role as unknown as string)) return true;

    const targetLocationId = await this.resolveTargetLocation(req, user);
    // Nothing location-shaped in this request: the endpoint is scoped by
    // tenant alone, and role/permission checks have already had their say.
    if (!targetLocationId) return true;

    const assigned = await this.prisma.userLocation.findFirst({
      where: { userId: user.userId, locationId: targetLocationId },
      select: { id: true },
    });
    if (!assigned) {
      throw new ForbiddenException("This device is not assigned to that location");
    }
    return true;
  }

  /**
   * The location this request is about, from whichever shape the route uses:
   * an explicit id in the params or query, or a KDS screen we can trace back
   * to one. Body ids are read too — a kiosk POSTs its order that way.
   */
  private async resolveTargetLocation(
    req: any,
    user: AuthenticatedUser,
  ): Promise<string | null> {
    const direct =
      req.params?.locationId ?? req.query?.locationId ?? req.body?.locationId;
    if (typeof direct === "string" && direct) return direct;

    const screenId = req.params?.screenId;
    if (typeof screenId === "string" && screenId) {
      const screen = await this.prisma.kdsScreen.findFirst({
        // Tenant-scoped so a bad id can't confirm another tenant's screen
        // exists, and so an unknown screen falls through to the endpoint's
        // own not-found rather than a confusing "wrong location".
        where: { id: screenId, tenantId: user.tenantId },
        select: { locationId: true },
      });
      return screen?.locationId ?? null;
    }

    return null;
  }
}
