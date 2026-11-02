import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from "@nestjs/common";
import { PrismaService } from "../../infrastructure/database/prisma.service";
import { TABLET_ROLE } from "../access/tablet-login";
import type { AuthenticatedUser } from "../../modules/auth/interfaces/jwt-payload.interface";

/**
 * Keeps a shop's shared counter tablet (LOCATION_TABLET) on its own shop in
 * Tables and Reservations.
 *
 * Those controllers check only the tenant: a list with no locationId returns
 * every shop, and `/:id` actions find any table or booking in the tenant.
 * DeviceLocationGuard already refuses a locationId that isn't the tablet's,
 * so this guard covers the other two: a tablet must name its location on a
 * list, and every table or booking it touches by id must belong to it.
 *
 * Every other role returns immediately — people who sign in as themselves
 * get exactly the behaviour they had before.
 */
@Injectable()
export class TabletShopGuard implements CanActivate {
  constructor(private readonly prisma: PrismaService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest();
    const user = req.user as AuthenticatedUser | undefined;
    if (!user || String(user.role) !== TABLET_ROLE) return true;

    const own = await this.prisma.userLocation.findMany({
      where: { userId: user.userId },
      select: { locationId: true },
    });
    const allowed = new Set(own.map((r) => r.locationId));
    const refuse = () => {
      throw new ForbiddenException("This tablet can only use its own shop");
    };

    const isReservations = String(req.baseUrl + req.path).includes("/reservations");
    const id = req.params?.id;
    const tableIds = [req.body?.tableId, req.body?.toTableId, req.body?.intoTableId].filter(
      (v): v is string => typeof v === "string" && !!v,
    );

    if (typeof id === "string" && id) {
      const row = isReservations
        ? await this.prisma.tableReservation.findFirst({
            where: { id },
            select: { locationId: true },
          })
        : await this.prisma.table.findFirst({ where: { id }, select: { locationId: true } });
      // Unknown id: let the endpoint return its own not-found.
      if (row && !allowed.has(row.locationId)) refuse();
    } else {
      const locationId = req.query?.locationId ?? req.body?.locationId;
      if (typeof locationId !== "string" || !allowed.has(locationId)) refuse();
    }

    if (tableIds.length) {
      const tables = await this.prisma.table.findMany({
        where: { id: { in: tableIds } },
        select: { locationId: true },
      });
      if (tables.some((t) => !allowed.has(t.locationId))) refuse();
    }
    return true;
  }
}
