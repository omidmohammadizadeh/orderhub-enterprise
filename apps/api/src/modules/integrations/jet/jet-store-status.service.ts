import { BadRequestException, Injectable, Logger, NotFoundException, Optional } from "@nestjs/common";
import { PrismaService } from "../../../infrastructure/database/prisma.service";
import { ActivityLogService } from "../../logs/activity-log.service";
import { JetClientService } from "./jet-client.service";

// Phase JE-5 — restaurant availability on Just Eat.
//
//   PUT /restaurants/{ref}/online         (no body)
//   PUT /restaurants/{ref}/offline        { onlineAt? }
//   PUT /restaurants/{ref}/servicetimes   { timezone, serviceTimes[] }
//
// TWO THINGS THE SPEC IS EXPLICIT ABOUT AND THE OPERATOR NEEDS TOLD
//
// 1. `offline` WITHOUT `onlineAt` IS INDEFINITE. A shop paused at Friday
//    teatime with no return time stays off Just Eat until somebody remembers.
//    Our own "stop taking orders" flow already knows when the pause ends, so
//    that time is passed through whenever we have it — and when we do not, the
//    caller is told what it just did.
//
// 2. SERVICE TIMES CANNOT WIDEN THE MENU. The real trading hours are the
//    intersection of the service times, the menu availability, and the
//    delivery-pool hours. Setting service times 07:00–12:00 against a menu
//    available 08:00–12:00 gets you 08:00–12:00, not 07:00. That is why the
//    menu publish falls back to ALL-DAY availability: all-day can be narrowed
//    here, but nothing can widen a too-narrow menu.

/** JET's two service types. Their casing is significant. */
const SERVICE_TYPES = ["Delivery", "Collection"] as const;

const DAYS = [
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
  "sunday",
] as const;

export interface JetOpeningTimes {
  [day: string]: Array<{ openingTime: string; closingTime: string }>;
}

/**
 * Our stored opening hours → JET's per-day {openingTime, closingTime} shape.
 *
 * Accepts the same three layouts the Deliveroo normaliser does, because that
 * is what location and brand rows actually hold: day-keyed slot arrays,
 * day-keyed {enabled, slots}, and the legacy [{day, open, close}] array.
 *
 * A closed day is OMITTED rather than sent as an empty array. Unlike the menu
 * availability schema, service times have no all-days-required rule, and an
 * empty array is ambiguous between "closed" and "unset".
 */
export function toJetOpeningTimes(hours: unknown): JetOpeningTimes {
  const out: JetOpeningTimes = {};
  const push = (day: string, from: unknown, to: unknown) => {
    const openingTime = String(from ?? "").trim();
    const closingTime = String(to ?? "").trim();
    if (!openingTime || !closingTime) return;
    (out[day] ??= []).push({ openingTime, closingTime });
  };

  if (Array.isArray(hours)) {
    for (const row of hours as any[]) {
      const day = String(row?.day ?? "").toLowerCase();
      if ((DAYS as readonly string[]).includes(day)) push(day, row?.open, row?.close);
    }
    return out;
  }

  if (hours && typeof hours === "object") {
    for (const day of DAYS) {
      const value = (hours as any)[day];
      if (!value) continue;
      if (Array.isArray(value)) {
        for (const slot of value) push(day, slot?.from, slot?.to);
      } else if (value.enabled === false) {
        continue;
      } else if (Array.isArray(value.slots)) {
        for (const slot of value.slots) push(day, slot?.from, slot?.to);
      }
    }
  }
  return out;
}

/**
 * JET wants a LOCAL ISO timestamp with no timezone — "2021-10-13T12:03:00".
 * Sending a UTC-suffixed one would be read as local and silently shift the
 * return time by the offset, which in British Summer Time is a whole hour of
 * a closed shop.
 */
export function toJetLocalTimestamp(date: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(date);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "00";
  // en-CA gives ISO-ordered date parts; hour can come back as "24" at midnight.
  const hour = get("hour") === "24" ? "00" : get("hour");
  return `${get("year")}-${get("month")}-${get("day")}T${hour}:${get("minute")}:${get("second")}`;
}

@Injectable()
export class JetStoreStatusService {
  private readonly logger = new Logger(JetStoreStatusService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly client: JetClientService,
    @Optional() private readonly activity?: ActivityLogService,
  ) {}

  /**
   * Take a restaurant offline or bring it back.
   *
   * `onlineUntil` is when the pause ENDS. Omitting it is legal and means
   * indefinite — which is a real operational hazard, so it is logged plainly
   * rather than left implicit.
   */
  async setStoreOnline(
    tenantId: string,
    connectionId: string,
    online: boolean,
    opts: { onlineAt?: Date | null } = {},
  ) {
    const target = await this.resolveConnection(tenantId, connectionId);

    let body: Record<string, unknown> | undefined;
    if (!online) {
      const onlineAt = opts.onlineAt
        ? toJetLocalTimestamp(opts.onlineAt, target.timezone)
        : null;
      body = onlineAt ? { onlineAt } : {};
      if (!onlineAt) {
        this.logger.warn(
          `JET taking restaurant ${target.restaurantReference} offline INDEFINITELY — ` +
            `no return time was given, so it stays off Just Eat until someone brings it back.`,
        );
      }
    }

    await this.client.request(
      "PUT",
      `/restaurants/${encodeURIComponent(target.restaurantReference)}/${online ? "online" : "offline"}`,
      {
        keyType: "menu",
        brandId: target.brandId,
        locationId: target.locationId,
        country: target.country,
        body,
        retries: 2,
      },
    );

    this.activity?.record({
      tenantId,
      brandId: target.brandId,
      locationId: target.locationId,
      category: "STATUS",
      channel: "JUST_EAT",
      action: online ? "store.resume" : "store.pause",
      status: "SUCCESS",
      message: online
        ? `Just Eat restaurant ${target.restaurantReference} brought back online`
        : `Just Eat restaurant ${target.restaurantReference} taken offline` +
          (opts.onlineAt ? ` until ${opts.onlineAt.toISOString()}` : " indefinitely"),
    });

    this.logger.log(
      `JET restaurant ${target.restaurantReference} → ${online ? "ONLINE" : "OFFLINE"}`,
    );
    return { ok: true, online, restaurant: target.restaurantReference };
  }

  /**
   * Push opening hours as JET service times.
   *
   * Delivery and Collection are set separately. We hold one set of hours per
   * location, so both service types get the same times — which is what the
   * shop actually does; a separate collection schedule would need somewhere to
   * store it first.
   */
  async publishServiceTimes(tenantId: string, connectionId: string) {
    const target = await this.resolveConnection(tenantId, connectionId);

    const [location, brand] = await Promise.all([
      this.prisma.location.findUnique({
        where: { id: target.locationId },
        select: { openingHours: true },
      }),
      target.brandId
        ? this.prisma.brand.findUnique({
            where: { id: target.brandId },
            select: { openingHours: true },
          })
        : Promise.resolve(null),
    ]);

    let openingTimes: JetOpeningTimes = {};
    for (const raw of [location?.openingHours, brand?.openingHours]) {
      if (!raw) continue;
      const candidate = toJetOpeningTimes(raw);
      if (Object.keys(candidate).length > 0) {
        openingTimes = candidate;
        break;
      }
    }

    if (Object.keys(openingTimes).length === 0) {
      // Sending an empty set would read as "closed every day" and take the
      // shop off Just Eat. Refusing is the safe failure.
      throw new BadRequestException(
        "No opening hours are set for this location or brand, so there are no service times to publish. " +
          "Set the hours first — pushing an empty set would close the restaurant on Just Eat.",
      );
    }

    const body = {
      timezone: target.timezone,
      serviceTimes: SERVICE_TYPES.map((serviceType) => ({
        serviceType,
        openingTimes,
      })),
    };

    await this.client.request(
      "PUT",
      `/restaurants/${encodeURIComponent(target.restaurantReference)}/servicetimes`,
      {
        keyType: "menu",
        brandId: target.brandId,
        locationId: target.locationId,
        country: target.country,
        body,
        retries: 2,
      },
    );

    const days = Object.keys(openingTimes);
    this.activity?.record({
      tenantId,
      brandId: target.brandId,
      locationId: target.locationId,
      category: "STATUS",
      channel: "JUST_EAT",
      action: "store.publish_hours",
      status: "SUCCESS",
      message: `Service times pushed to Just Eat restaurant ${target.restaurantReference} (${days.length} open days)`,
      details: { days, timezone: target.timezone },
    });

    this.logger.log(
      `JET servicetimes ${target.restaurantReference}: [${days.join(",")}] tz=${target.timezone}`,
    );
    // The narrowing rule is worth surfacing: an operator who widens their
    // hours here and sees no change is looking at a menu-availability limit.
    return {
      ok: true,
      days,
      timezone: target.timezone,
      note:
        "Just Eat trades on the intersection of these service times, the menu availability " +
        "and the delivery-pool hours — widening beyond the menu's hours needs a menu re-publish.",
    };
  }

  /**
   * Reconcile every connected Just Eat restaurant in scope with our own pause
   * state. Called by PauseService alongside the Deliveroo and Uber Eats
   * reconcilers so "Stop taking orders" reaches Just Eat too.
   */
  async reconcile(args: {
    tenantId: string;
    brandId?: string | null;
    locationId?: string | null;
    paused: boolean;
    until?: Date | null;
  }): Promise<void> {
    const connections = await this.prisma.brandPlatformConnection.findMany({
      where: {
        tenantId: args.tenantId,
        platform: "JUST_EAT",
        status: { not: "not_connected" },
        ...(args.brandId ? { brandId: args.brandId } : {}),
        ...(args.locationId ? { locationId: args.locationId } : {}),
      },
      select: { id: true },
    });

    for (const conn of connections) {
      try {
        await this.setStoreOnline(args.tenantId, conn.id, !args.paused, {
          onlineAt: args.until ?? null,
        });
      } catch (e: any) {
        // Best-effort: one unreachable restaurant must not stop the operator
        // pausing the rest of their estate.
        this.logger.warn(
          `JET reconcile failed for connection ${conn.id}: ${e?.message}`,
        );
      }
    }
  }

  private async resolveConnection(tenantId: string, connectionId: string) {
    const conn = await this.prisma.brandPlatformConnection.findFirst({
      where: { id: connectionId, tenantId, platform: "JUST_EAT" },
      select: {
        id: true,
        brandId: true,
        locationId: true,
        externalStoreId: true,
        metadata: true,
        location: { select: { timezone: true } },
      },
    });
    if (!conn) throw new NotFoundException("Just Eat connection not found");

    const metadata = (conn.metadata ?? {}) as Record<string, any>;
    const restaurantReference =
      (metadata.restaurantReference ?? "").trim?.() || conn.externalStoreId;
    if (!restaurantReference) {
      throw new BadRequestException(
        "This Just Eat connection has no restaurant reference. Add it under the brand's Just Eat settings.",
      );
    }
    return {
      brandId: conn.brandId,
      locationId: conn.locationId,
      restaurantReference,
      country: metadata.country ?? null,
      timezone: (conn.location as any)?.timezone || "Europe/London",
    };
  }
}
