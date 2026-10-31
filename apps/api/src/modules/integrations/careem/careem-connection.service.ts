import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from "@nestjs/common";
import { PrismaService } from "../../../infrastructure/database/prisma.service";
import { ActivityLogService } from "../../logs/activity-log.service";
import { CareemClientService } from "./careem-client.service";
import { CareemStoreService, type CareemTarget } from "./careem-store.service";

// Which Careem branch is which of our brand × location pairs.
//
// Careem have no store id to paste: we choose the branch id and register it, and
// their operations team then maps it to an outlet by hand. The id is this row's
// own id and stays on the row after a disconnect, so reconnecting a shop never
// asks Careem to map it twice.
//
// The status chip reads: pending = registered, not yet taking orders here;
// connected = mapped with POS integration on, so orders come to us.
//
// Staging and production are separate systems with separate branches, and this
// app runs against one at a time. Each row remembers where it was registered,
// so switching CAREEM_ENV shows "register again" instead of a false "connected".

const CAREEM_COUNTRIES = new Set(["AE", "JO", "SA"]);

type Row = {
  id: string;
  tenantId: string;
  brandId: string;
  locationId: string;
  status: string;
  externalStoreId: string | null;
  lastWebhookAt: Date | null;
  lastError: string | null;
  metadata: unknown;
};

@Injectable()
export class CareemConnectionService {
  private readonly logger = new Logger(CareemConnectionService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly client: CareemClientService,
    private readonly store: CareemStoreService,
    @Optional() private readonly activity?: ActivityLogService,
  ) {}

  /**
   * Register this brand at this location with Careem.
   *
   * Safe to repeat, and never turns POS integration on: a shop already trading
   * on Careem would otherwise send us live orders the moment operations map it,
   * before our catalog exists there.
   */
  async connect(
    tenantId: string,
    body: { brandId: string; locationId: string },
  ) {
    if (!this.client.configured()) {
      throw new BadRequestException(
        "Careem credentials aren't set on the server yet.",
      );
    }
    const [brand, location] = await Promise.all([
      this.prisma.brand.findFirst({
        where: { id: body.brandId, tenantId, deletedAt: null },
        select: { id: true, name: true },
      }),
      this.prisma.location.findFirst({
        where: { id: body.locationId, deletedAt: null, brand: { tenantId } },
        select: { id: true, name: true, country: true },
      }),
    ]);
    if (!brand) throw new NotFoundException("Brand not found");
    if (!location) throw new NotFoundException("Location not found");
    if (!CAREEM_COUNTRIES.has(String(location.country ?? "").toUpperCase())) {
      throw new BadRequestException(
        "Careem's POS API covers the UAE, Jordan and Saudi Arabia only. Check the country on this location.",
      );
    }

    const where = {
      brandId_locationId_platform: {
        brandId: brand.id,
        locationId: location.id,
        platform: "CAREEM",
      },
    };
    const existing = await this.prisma.brandPlatformConnection.findUnique({
      where,
    });
    const row =
      existing ??
      (await this.prisma.brandPlatformConnection.create({
        data: {
          tenantId,
          brandId: brand.id,
          locationId: location.id,
          platform: "CAREEM",
          // Only pending once Careem have the branch, so a failed attempt
          // leaves Connect on offer rather than a connection with nothing behind it.
          status: "not_connected",
        },
      }));
    const branchId = row.externalStoreId ?? row.id;
    const target: CareemTarget = {
      branchId,
      brandId: brand.id,
      locationId: location.id,
    };

    await this.store.registerBrand(tenantId, brand.id);
    // The outlet name customers see is set by Careem at mapping. This is what
    // their operations team reads when finding the branch to map.
    const branch = await this.store.putBranch(
      target,
      brand.name === location.name
        ? brand.name
        : `${brand.name} - ${location.name}`,
    );
    // Careem refuse hours for an unmapped branch ("branch_id is not mapped"), so
    // a new branch gets them with its first menu publish instead.
    if (branch?.state === "MAPPED") {
      await this.store.publishHoursFor(tenantId, target);
    }

    const meta = (row.metadata ?? {}) as Record<string, any>;
    const sameEnvironment = meta.careemEnv === this.client.env;
    const updated = await this.prisma.brandPlatformConnection.update({
      where: { id: row.id },
      data: {
        externalStoreId: branchId,
        externalBrandId: brand.id,
        status: "pending",
        lastError: null,
        metadata: {
          // A different environment is a different branch: nothing it had
          // carries over.
          ...(sameEnvironment ? meta : {}),
          careemEnv: this.client.env,
          posIntegration: sameEnvironment ? !!meta.posIntegration : false,
        } as never,
      },
    });
    this.activity?.record({
      tenantId,
      brandId: brand.id,
      locationId: location.id,
      category: "CONNECTION",
      channel: "CAREEM",
      action: "connection.connect",
      status: "SUCCESS",
      message: `Registered with Careem (${branch?.state ?? "UNMAPPED"}). Careem operations must map branch ${branchId} to an outlet.`,
    });
    return this.health(tenantId, updated.id);
  }

  /** The connection as Careem see it right now. Keeps the chip honest. */
  async health(tenantId: string, connectionId: string) {
    const row = await this.row(tenantId, connectionId);
    const meta = (row.metadata ?? {}) as Record<string, any>;
    const registered = row.status !== "not_connected" && !!row.externalStoreId;
    const wrongEnvironment = registered && meta.careemEnv !== this.client.env;

    let state: string | null = null;
    let catalogOnBranch = false;
    let visibility: {
      status: string;
      reason: string | null;
      can_reactivate: boolean | null;
    } | null = null;
    let error: string | null = null;

    if (registered && !wrongEnvironment && this.client.configured()) {
      const target = this.target(row);
      try {
        const branch = await this.store.readBranch(target);
        state = branch?.state ?? "UNMAPPED";
        catalogOnBranch = !!branch?.catalog_id;
        if (state === "MAPPED") {
          visibility = await this.store.readVisibility(target);
        }
      } catch (err) {
        error = (err as Error).message;
        this.logger.warn(`Careem health ${row.id}: ${error}`);
      }
    }

    const mapped = state === "MAPPED";
    const posIntegration = !!meta.posIntegration;
    if (!error && registered && !wrongEnvironment && state) {
      const status = mapped && posIntegration ? "connected" : "pending";
      if (status !== row.status) {
        await this.prisma.brandPlatformConnection.update({
          where: { id: row.id },
          data: { status },
        });
        row.status = status;
      }
    }

    return {
      id: row.id,
      brandId: row.brandId,
      locationId: row.locationId,
      status: row.status,
      environment: this.client.env,
      configured: this.client.configured(),
      branchId: row.externalStoreId,
      registered,
      wrongEnvironment,
      state,
      mapped,
      posIntegration,
      catalogOnBranch,
      catalog: presentCatalog(meta.careemCatalog),
      visibility,
      lastWebhookAt: row.lastWebhookAt,
      lastError: error ?? row.lastError,
    };
  }

  /**
   * Point orders at us, or back at the branch's own Careem tablet.
   *
   * Turning on is refused until the branch is mapped and our catalog is live
   * there. Before that an order names items we cannot resolve, and the kitchen
   * gets a ticket of ids.
   */
  async setOrders(tenantId: string, connectionId: string, active: boolean) {
    const row = await this.row(tenantId, connectionId);
    const target = this.target(row);
    if (active) {
      const branch = await this.store.readBranch(target);
      if (branch?.state !== "MAPPED") {
        throw new BadRequestException(
          "Careem operations haven't mapped this branch yet, so it has no outlet to take orders from.",
        );
      }
      const catalogStatus = ((row.metadata ?? {}) as Record<string, any>)
        .careemCatalog?.status;
      if (catalogStatus !== "COMPLETED" && !branch.catalog_id) {
        throw new BadRequestException(
          "Publish the menu and wait for Careem to complete it before turning orders on.",
        );
      }
    }
    await this.store.setPosIntegrationFor(target, active);
    await this.mergeMeta(row, { posIntegration: active });
    this.activity?.record({
      tenantId,
      brandId: row.brandId,
      locationId: row.locationId,
      category: "CONNECTION",
      channel: "CAREEM",
      action: active ? "connection.orders_on" : "connection.orders_off",
      status: "INFO",
      message: active
        ? "Careem orders now come to OrderHub."
        : "Careem orders go back to the branch's Careem tablet.",
    });
    return this.health(tenantId, row.id);
  }

  async pause(tenantId: string, connectionId: string, minutes: number) {
    const row = await this.row(tenantId, connectionId);
    await this.store.pauseTargetFor(this.target(row), minutes);
    return this.health(tenantId, row.id);
  }

  async resume(tenantId: string, connectionId: string) {
    const row = await this.row(tenantId, connectionId);
    await this.store.setVisibilityFor(this.target(row), true);
    return this.health(tenantId, row.id);
  }

  async publishHours(tenantId: string, connectionId: string) {
    const row = await this.row(tenantId, connectionId);
    const res = await this.store.publishHoursFor(tenantId, this.target(row));
    this.activity?.record({
      tenantId,
      brandId: row.brandId,
      locationId: row.locationId,
      category: "CONNECTION",
      channel: "CAREEM",
      action: "hours.publish",
      status: "SUCCESS",
      message: "Opening hours sent to Careem.",
    });
    return res;
  }

  /** The Publish hours pop-up picks a brand, not a location: send them all. */
  async publishHoursForBrand(tenantId: string, brandId: string) {
    const rows = await this.prisma.brandPlatformConnection.findMany({
      where: {
        tenantId,
        brandId,
        platform: "CAREEM",
        externalStoreId: { not: null },
        status: { not: "not_connected" },
      },
    });
    if (!rows.length) {
      throw new BadRequestException(
        "Careem isn't connected for this brand yet. Connect it under Locations → Brands → Careem first.",
      );
    }
    for (const row of rows) await this.publishHours(tenantId, row.id);
    return { pushed: rows.length };
  }

  /**
   * Stop using Careem here. Orders go back to the branch's tablet first; if that
   * call fails the connection stays as it was, because a shop that looks
   * disconnected but still sends us orders is the worst outcome.
   *
   * The branch id stays on the row, so a late order still finds its shop and
   * reconnecting needs no second mapping.
   */
  async disconnect(tenantId: string, connectionId: string) {
    const row = await this.row(tenantId, connectionId);
    const meta = (row.metadata ?? {}) as Record<string, any>;
    if (meta.posIntegration && meta.careemEnv === this.client.env) {
      await this.store.setPosIntegrationFor(this.target(row), false);
    }
    await this.prisma.brandPlatformConnection.update({
      where: { id: row.id },
      data: {
        status: "not_connected",
        metadata: { ...meta, posIntegration: false } as never,
      },
    });
    this.activity?.record({
      tenantId,
      brandId: row.brandId,
      locationId: row.locationId,
      category: "CONNECTION",
      channel: "CAREEM",
      action: "connection.disconnect",
      status: "INFO",
      message: "Careem disconnected. Orders go to the branch's Careem tablet.",
    });
    return { ok: true };
  }

  private target(row: Row): CareemTarget {
    if (!row.externalStoreId) {
      throw new BadRequestException("Connect this brand to Careem first.");
    }
    return {
      branchId: row.externalStoreId,
      brandId: row.brandId,
      locationId: row.locationId,
    };
  }

  private async row(tenantId: string, connectionId: string): Promise<Row> {
    const row = await this.prisma.brandPlatformConnection.findFirst({
      where: { id: connectionId, tenantId, platform: "CAREEM" },
    });
    if (!row) throw new NotFoundException("Careem connection not found");
    return row as Row;
  }

  private async mergeMeta(row: Row, patch: Record<string, unknown>) {
    await this.prisma.brandPlatformConnection.update({
      where: { id: row.id },
      data: {
        metadata: {
          ...((row.metadata ?? {}) as Record<string, unknown>),
          ...patch,
        } as never,
      },
    });
  }
}

/** The item ids are for 86 pushes, not for a browser. */
function presentCatalog(catalog: any) {
  if (!catalog) return null;
  const { itemIds: _itemIds, ...rest } = catalog;
  return rest;
}
