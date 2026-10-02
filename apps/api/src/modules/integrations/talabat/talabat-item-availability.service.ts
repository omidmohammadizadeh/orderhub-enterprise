import { Injectable, Logger, Optional } from "@nestjs/common";
import { OnEvent } from "@nestjs/event-emitter";
import { PrismaService } from "../../../infrastructure/database/prisma.service";
import { ActivityLogService } from "../../logs/activity-log.service";
import { TalabatClientService } from "./talabat-client.service";
import { talabatSettings } from "./talabat-connection.service";

// Phase TB-5 — 86 an item, or a single choice, on Talabat.
//
//   PUT /v2/chains/{chainCode}/vendors/{posVendorId}/catalog/items/availability
//   { globalEntityId, items: [ids], type: "ITEM" | "TOPPING", isAvailable,
//     willBeAvailable?: "NEXT_BUSINESS_DAY" | "AT_TIMESTAMP", atTimeStamp? }
//   → 204 all applied, 200 partial (per-platform-vendor results), 4xx/5xx
//
// Talabat's certification lists "Item Availability (item + choice/modifier
// per vendor ID)" as mandatory, so both kinds are pushed:
//
//   • ITEM — a MenuItem, by its id (what the catalog was published under),
//     plus its same-brand twins (two board rows for one product — JET's
//     lesson: the row the operator 86'd is not always the row we published).
//   • TOPPING — a modifier option, by every catalog id it went out under
//     (second-level and per-size copies are saved at publish time).
//
// Unlike Glovo and Careem, Talabat take a timed 86 natively (AT_TIMESTAMP),
// so a "1 hour" snooze needs no sweep of ours to come back.

const CHUNK = 100;

@Injectable()
export class TalabatItemAvailabilityService {
  private readonly logger = new Logger(TalabatItemAvailabilityService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly client: TalabatClientService,
    @Optional() private readonly activity?: ActivityLogService,
  ) {}

  /** MenuAvailabilityService fan-out — an item snoozed or restored. */
  async pushItemAvailability(args: {
    tenantId: string;
    itemId: string;
    available: boolean;
    until?: Date | null;
    locationId?: string;
  }): Promise<{ pushed: number }> {
    if (!this.client.configured()) return { pushed: 0 };
    const item = await this.prisma.menuItem.findUnique({
      where: { id: args.itemId },
      select: { id: true, name: true, brandId: true },
    });
    if (!item) return { pushed: 0 };
    const owned = await this.prisma.brand.findFirst({
      where: { id: item.brandId, tenantId: args.tenantId },
      select: { id: true },
    });
    if (!owned) return { pushed: 0 };

    // Twins: same brand, same name, different row. Their ids are what a
    // menu built from the other row was published under.
    const twins = await this.prisma.menuItem
      .findMany({
        where: { brandId: item.brandId, name: { equals: item.name, mode: "insensitive" }, id: { not: item.id } },
        select: { id: true },
      })
      .catch(() => [] as Array<{ id: string }>);
    const ids = [item.id, ...twins.map((t) => t.id)];

    const conns = await this.targets(args.tenantId, args.locationId);
    let pushed = 0;
    for (const c of conns) {
      // A restore must not undo a snooze that still applies there.
      if (args.available && (await this.stillSnoozed(item.id, c.locationId))) continue;
      // Only ids this vendor was actually sent. Before the first publish
      // there is no record, so every candidate goes and Talabat ignore the
      // ones they don't know.
      const published = talabatSettings(c).talabatCatalog?.itemIds as string[] | undefined;
      const mine = published ? ids.filter((id) => published.includes(id)) : ids;
      if (!mine.length) continue;
      if (await this.send(c, "ITEM", mine, args.available, args.until ?? null, `"${item.name}"`)) pushed++;
    }
    return { pushed };
  }

  /** A modifier option switched on or off in the menu editor. */
  @OnEvent("modifier_option.availability_changed")
  async onOptionAvailability(payload: { tenantId: string; optionId: string; available: boolean; name?: string }) {
    try {
      await this.pushOptionAvailability(payload);
    } catch (e: any) {
      this.logger.warn(`Talabat option availability push failed: ${e?.message}`);
    }
  }

  async pushOptionAvailability(args: {
    tenantId: string;
    optionId: string;
    available: boolean;
    locationId?: string;
    name?: string;
  }): Promise<{ pushed: number }> {
    if (!this.client.configured()) return { pushed: 0 };
    const conns = await this.targets(args.tenantId, args.locationId);
    let pushed = 0;
    for (const c of conns) {
      const aliases = (talabatSettings(c).talabatCatalog?.optionAliases ?? {}) as Record<string, string[]>;
      const ids = aliases[args.optionId] ?? [args.optionId];
      if (await this.send(c, "TOPPING", ids, args.available, null, `option "${args.name ?? args.optionId}"`)) pushed++;
    }
    return { pushed };
  }

  private async send(
    c: { id: string; tenantId: string; brandId: string; locationId: string; externalStoreId: string | null; metadata: unknown },
    type: "ITEM" | "TOPPING",
    ids: string[],
    available: boolean,
    until: Date | null,
    label: string,
  ): Promise<boolean> {
    const s = talabatSettings(c);
    if (!s.chainCode || !c.externalStoreId) return false;
    const path =
      `/v2/chains/${encodeURIComponent(s.chainCode)}` +
      `/vendors/${encodeURIComponent(c.externalStoreId)}/catalog/items/availability`;
    const timed = !available && until && until.getTime() > Date.now();
    const log = {
      tenantId: c.tenantId,
      brandId: c.brandId,
      locationId: c.locationId,
      category: "INVENTORY" as const,
      channel: "TALABAT",
      action: available ? "item.restore.push" : "item.86.push",
    };
    try {
      let partial: unknown = null;
      for (let i = 0; i < ids.length; i += CHUNK) {
        const res = await this.client.request<any>(path, {
          method: "PUT",
          body: {
            // "should be provided if available or can be ignored if unavailable"
            ...(s.globalEntityId ? { globalEntityId: s.globalEntityId } : {}),
            items: ids.slice(i, i + CHUNK),
            type,
            isAvailable: available,
            ...(timed ? { willBeAvailable: "AT_TIMESTAMP", atTimeStamp: until!.toISOString() } : {}),
          },
        });
        if (res.status === 200) partial = res.data;
      }
      this.activity?.record({
        ...log,
        status: partial ? "WARNING" : "SUCCESS",
        message:
          `${label} marked ${available ? "available" : "unavailable"} on Talabat` +
          (timed ? ` until ${until!.toISOString().slice(0, 16).replace("T", " ")} UTC` : "") +
          (partial ? " — only partly applied, see details" : ""),
        details: { ids, type, ...(partial ? { result: partial } : {}) },
      });
      return true;
    } catch (err: any) {
      this.logger.warn(`Talabat availability ${type} failed for ${c.externalStoreId}: ${err?.message}`);
      this.activity?.record({
        ...log,
        status: "ERROR",
        message: `Talabat availability push failed for ${label}: ${err?.message}`,
        details: { ids, type },
      });
      return false;
    }
  }

  private async targets(tenantId: string, locationId?: string) {
    return this.prisma.brandPlatformConnection.findMany({
      where: {
        tenantId,
        platform: "TALABAT",
        status: { not: "not_connected" },
        externalStoreId: { not: null },
        ...(locationId ? { locationId } : {}),
      },
      select: { id: true, tenantId: true, brandId: true, locationId: true, externalStoreId: true, metadata: true },
    });
  }

  private async stillSnoozed(itemId: string, locationId: string): Promise<boolean> {
    const now = new Date();
    const hit = await (this.prisma as any).menuItemChannelAvailability
      .findFirst({
        where: {
          itemId,
          channel: { in: ["TALABAT", "ALL"] },
          AND: [
            { OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] },
            { OR: [{ locationId: null }, { locationId }] },
          ],
        },
        select: { id: true },
      })
      .catch(() => null);
    return !!hit;
  }
}
