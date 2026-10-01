import { Injectable, Logger, NotFoundException } from "@nestjs/common";
import {
  DISPATCH_CHARGING_SETTINGS_KEY,
  dispatchChargingFromSettings,
} from "@orderhub/shared";
import { PrismaService } from "../../infrastructure/database/prisma.service";

// ── Dispatch charging (Admin Dashboard → Dispatch charging) ─────────────────
//
// Per-location switch: does a courier dispatch take OrderHub's fee out of the
// location's wallet, or run free?
//
// Charged is the default and the only state a trading shop should be in. The
// waiver exists so a sandbox dispatch — Stuart's bot couriers, Uber's test
// mode, JET Go's /simulate — can be driven end to end without first funding a
// wallet on a shop that will never take a real order.
//
// It replaced an implicit rule where the fee was skipped whenever the person
// clicking Dispatch was a PLATFORM_ADMIN. That meant admin dispatches on REAL
// shops were silently free, with nothing on screen to say so. Now the waiver
// belongs to the shop, is visible, and has to be ticked deliberately.
//
// Admin-only, and LocationsService strips the key from ordinary location PATCH
// bodies, so a tenant cannot switch off its own billing.

export interface DispatchChargingRow {
  locationId: string;
  locationName: string;
  brandName: string | null;
  waiveWalletCharge: boolean;
  note: string | null;
  updatedAt: string | null;
}

@Injectable()
export class DispatchChargingService {
  private readonly logger = new Logger(DispatchChargingService.name);

  constructor(private readonly prisma: PrismaService) {}

  private async requireLocation(tenantId: string, locationId: string) {
    const row = await this.prisma.location.findFirst({
      where: { id: locationId, deletedAt: null, brand: { tenantId } },
      select: {
        id: true,
        name: true,
        settings: true,
        brand: { select: { name: true } },
      },
    });
    if (!row) throw new NotFoundException("Location not found");
    return row;
  }

  private toRow(l: {
    id: string;
    name: string;
    settings: unknown;
    brand?: { name: string } | null;
  }): DispatchChargingRow {
    const s = dispatchChargingFromSettings(l.settings);
    return {
      locationId: l.id,
      locationName: l.name,
      brandName: l.brand?.name ?? null,
      waiveWalletCharge: s.waiveWalletCharge,
      note: s.note ?? null,
      updatedAt: s.updatedAt ?? null,
    };
  }

  /** Every location in the tenant, so the waived ones are visible in one look
   *  rather than found by opening each shop in turn. */
  async list(tenantId: string): Promise<DispatchChargingRow[]> {
    const rows = await this.prisma.location.findMany({
      where: { deletedAt: null, brand: { tenantId } },
      select: {
        id: true,
        name: true,
        settings: true,
        brand: { select: { name: true } },
      },
      orderBy: { name: "asc" },
    });
    return rows.map((l) => this.toRow(l));
  }

  async get(tenantId: string, locationId: string): Promise<DispatchChargingRow> {
    return this.toRow(await this.requireLocation(tenantId, locationId));
  }

  async set(
    tenantId: string,
    locationId: string,
    waiveWalletCharge: boolean,
    note: string | null | undefined,
    actor: { userId?: string; role?: string } = {},
  ): Promise<DispatchChargingRow> {
    const row = await this.requireLocation(tenantId, locationId);
    const before = dispatchChargingFromSettings(row.settings);
    const waive = waiveWalletCharge === true;

    const settings = {
      ...((row.settings as Record<string, unknown> | null) ?? {}),
      [DISPATCH_CHARGING_SETTINGS_KEY]: {
        waiveWalletCharge: waive,
        note: typeof note === "string" && note.trim() ? note.trim() : null,
        updatedAt: new Date().toISOString(),
      },
    };

    await this.prisma.location.update({
      where: { id: locationId },
      data: { settings: settings as any },
    });

    if (before.waiveWalletCharge !== waive) {
      // Worth a line in the log either way: turning it ON means this shop stops
      // paying for couriers, and leaving it on by accident is the failure mode.
      this.logger.warn(
        `Dispatch wallet charge ${waive ? "WAIVED" : "RE-ENABLED"} for location ${locationId} ` +
          `by ${actor.userId ?? "?"} (${actor.role ?? "?"})`,
      );
    }

    return this.toRow({ ...row, settings });
  }
}
