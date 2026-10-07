import { BadRequestException, Injectable, Logger, NotFoundException, Optional } from "@nestjs/common";
import { Cron, CronExpression } from "@nestjs/schedule";
import { timezoneForCountry } from "@orderhub/shared";
import { PrismaService } from "../../../infrastructure/database/prisma.service";
import { HubRiseCatalogService } from "../../integrations/hubrise/hubrise-catalog.service";
import { DeliverooMenuPublishService } from "../../integrations/deliveroo/deliveroo-menu-publish.service";
import { UberEatsMenuPublishService } from "../../integrations/ubereats/ubereats-menu-publish.service";
import { JetMenuPublishService } from "../../integrations/jet/jet-menu-publish.service";
import { ActivityLogService } from "../../logs/activity-log.service";
import {
  AUTO_PUBLISH_CHANNELS,
  type AutoPublishChannel,
  isValidTime,
  isValidTimezone,
  nextRunAfter,
} from "./schedule";

export interface AutoPublishRunResult {
  channel: AutoPublishChannel;
  locationId: string | null;
  locationName: string | null;
  ok: boolean;
  message: string;
}

const CHANNEL_LABEL: Record<AutoPublishChannel, string> = {
  JUST_EAT: "Just Eat",
  DELIVEROO: "Deliveroo",
  UBER_EATS: "Uber Eats",
  HUBRISE: "HubRise",
};

/**
 * Auto publish — re-push a menu to its marketplace channels on a weekly
 * schedule. The point is Just Eat: JET order injection sometimes stops for a
 * store until the menu is published again, so a scheduled publish keeps it
 * healthy without anyone remembering to press the button.
 *
 * A run publishes to every location the menu SERVES on each chosen channel
 * (its MenuChannelAssignment rows — the same locations the Publish dialog
 * wrote), through the very same services the Publish button calls.
 */
@Injectable()
export class MenuAutoPublishService {
  private readonly logger = new Logger(MenuAutoPublishService.name);
  private ticking = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly hubrise: HubRiseCatalogService,
    private readonly deliveroo: DeliverooMenuPublishService,
    private readonly uberEats: UberEatsMenuPublishService,
    private readonly jet: JetMenuPublishService,
    @Optional() private readonly activity?: ActivityLogService,
  ) {}

  // ── Read / write ───────────────────────────────────────────────────────────

  async get(menuId: string, tenantId: string) {
    const menu = await this.assertMenu(menuId, tenantId);
    const row = await this.prisma.menuAutoPublish.findUnique({ where: { menuId } });
    const targets = await this.targets(menu, [...AUTO_PUBLISH_CHANNELS]);
    return {
      schedule: row ? this.toDto(row) : null,
      defaultTimezone: menu.timezone,
      // Where a run would publish right now, per channel — shown in the editor
      // so nobody schedules a channel the menu isn't published to.
      targets: Object.fromEntries(
        AUTO_PUBLISH_CHANNELS.map((c) => [
          c,
          (targets[c] ?? []).map((t) => ({ locationId: t.locationId, locationName: t.locationName })),
        ]),
      ),
    };
  }

  async save(menuId: string, tenantId: string, body: Record<string, unknown>, userId?: string) {
    const menu = await this.assertMenu(menuId, tenantId);

    const channels = Array.isArray(body.channels)
      ? ([...new Set(body.channels)].filter((c) =>
          (AUTO_PUBLISH_CHANNELS as readonly string[]).includes(String(c)),
        ) as AutoPublishChannel[])
      : [];
    const days = Array.isArray(body.days)
      ? [...new Set(body.days.map(Number).filter((d) => Number.isInteger(d) && d >= 0 && d <= 6))].sort()
      : [];
    const times = Array.isArray(body.times)
      ? [...new Set(body.times.map((t) => String(t).trim()).filter(isValidTime))].sort().slice(0, 12)
      : [];
    const timezone =
      typeof body.timezone === "string" && isValidTimezone(body.timezone) ? body.timezone : menu.timezone;
    const enabled = body.enabled !== false;

    if (enabled) {
      if (!channels.length) throw new BadRequestException("Pick at least one channel to publish to");
      if (!days.length) throw new BadRequestException("Pick at least one day");
      if (!times.length) throw new BadRequestException("Add at least one time (HH:mm)");
    }

    const nextRunAt = enabled ? nextRunAfter(new Date(), { days, times, timezone }) : null;
    const data = { enabled, channels, days, times, timezone, nextRunAt, createdBy: userId ?? null };
    const row = await this.prisma.menuAutoPublish.upsert({
      where: { menuId },
      create: { tenantId, menuId, ...data },
      update: data,
    });
    return this.toDto(row);
  }

  async remove(menuId: string, tenantId: string) {
    await this.assertMenu(menuId, tenantId);
    await this.prisma.menuAutoPublish.deleteMany({ where: { menuId } });
    return { ok: true };
  }

  /** "Run now" from the editor — same as a scheduled run, schedule untouched. */
  async runNow(menuId: string, tenantId: string) {
    await this.assertMenu(menuId, tenantId);
    const row = await this.prisma.menuAutoPublish.findUnique({ where: { menuId } });
    if (!row) throw new BadRequestException("Save the auto-publish schedule first");
    return this.execute(row, "manual");
  }

  // ── Scheduler ──────────────────────────────────────────────────────────────

  @Cron(CronExpression.EVERY_MINUTE)
  async tick(): Promise<void> {
    if (this.ticking) return; // a slow run must not overlap the next minute
    this.ticking = true;
    try {
      const now = new Date();
      const due = await this.prisma.menuAutoPublish.findMany({
        where: { enabled: true, nextRunAt: { lte: now } },
        orderBy: { nextRunAt: "asc" },
        take: 25,
      });
      for (const row of due) {
        // Claim it: move nextRunAt on ONLY if nobody else has. With more than
        // one API instance, exactly one wins and the others skip.
        const next = nextRunAfter(now, row);
        const claimed = await this.prisma.menuAutoPublish.updateMany({
          where: { id: row.id, nextRunAt: row.nextRunAt },
          data: { nextRunAt: next },
        });
        if (claimed.count !== 1) continue;
        await this.execute(row, "schedule").catch((err) =>
          this.logger.error(`Auto publish ${row.menuId} crashed: ${err?.message ?? err}`),
        );
      }
    } catch (err: any) {
      this.logger.error(`Auto publish tick failed: ${err?.message ?? err}`);
    } finally {
      this.ticking = false;
    }
  }

  // ── Running ────────────────────────────────────────────────────────────────

  async execute(row: { id: string; menuId: string; tenantId: string; channels: string[] }, trigger: "schedule" | "manual") {
    const menu = await this.prisma.menu.findFirst({
      where: { id: row.menuId, deletedAt: null, brand: { tenantId: row.tenantId } },
      select: { id: true, name: true, brandId: true, locationId: true },
    });
    const results: AutoPublishRunResult[] = [];
    if (!menu) {
      results.push({ channel: "JUST_EAT", locationId: null, locationName: null, ok: false, message: "Menu no longer exists" });
    } else {
      const channels = row.channels.filter((c): c is AutoPublishChannel =>
        (AUTO_PUBLISH_CHANNELS as readonly string[]).includes(c),
      );
      const targets = await this.targets(menu, channels);
      for (const channel of channels) {
        for (const t of targets[channel] ?? []) {
          results.push(await this.publishOne(row.tenantId, menu.id, channel, t));
        }
      }
    }

    const okCount = results.filter((r) => r.ok).length;
    const status = results.length && okCount === results.length ? "ok" : okCount > 0 ? "partial" : "failed";
    await this.prisma.menuAutoPublish.update({
      where: { id: row.id },
      data: { lastRunAt: new Date(), lastStatus: status, lastResult: results as any },
    });

    for (const r of results) {
      this.activity?.record({
        tenantId: row.tenantId,
        locationId: r.locationId,
        category: "MENU",
        channel: r.channel,
        action: "menu.auto_publish",
        status: r.ok ? "SUCCESS" : "ERROR",
        message: `Auto publish (${trigger === "manual" ? "run now" : "scheduled"}) of "${menu?.name ?? row.menuId}" to ${
          CHANNEL_LABEL[r.channel]
        }${r.locationName ? ` · ${r.locationName}` : ""}: ${r.message}`,
        details: { menuId: row.menuId, trigger },
      });
    }
    this.logger.log(`Auto publish ${row.menuId} (${trigger}): ${status} ${okCount}/${results.length}`);
    return { status, results, ranAt: new Date().toISOString() };
  }

  private async publishOne(
    tenantId: string,
    menuId: string,
    channel: AutoPublishChannel,
    t: { locationId: string | null; brandId: string | null; locationName: string | null },
  ): Promise<AutoPublishRunResult> {
    const base = { channel, locationId: t.locationId, locationName: t.locationName };
    try {
      const locationId = t.locationId ?? undefined;
      switch (channel) {
        case "JUST_EAT":
          await this.jet.publishMenu({ tenantId, menuId, locationId });
          // JET's 202 only means the structure parsed; the verdict arrives on
          // their menu callback, which logs separately.
          return { ...base, ok: true, message: "Sent — Just Eat is processing it" };
        case "DELIVEROO": {
          const r: any = await this.deliveroo.publishMenu({ tenantId, menuId, locationId });
          const warnings = Array.isArray(r?.warnings) ? r.warnings.length : 0;
          return { ...base, ok: true, message: warnings ? `Published with ${warnings} warning(s)` : "Published" };
        }
        case "UBER_EATS":
          await this.uberEats.publishMenu({ tenantId, menuId, locationId, brandId: t.brandId ?? undefined });
          return { ...base, ok: true, message: "Published" };
        case "HUBRISE":
          await this.hubrise.publishMenu({ tenantId, menuId });
          return { ...base, ok: true, message: "Published" };
      }
    } catch (err: any) {
      const msg = err?.response?.message ?? err?.message ?? "failed";
      return { ...base, ok: false, message: String(Array.isArray(msg) ? msg.join("; ") : msg).slice(0, 300) };
    }
  }

  /**
   * Where each channel publishes: one entry per location (and brand) the menu
   * is assigned to on that channel. A menu with no assignment for a channel
   * falls back to its own home location — what the Publish button does when
   * no location was picked. HubRise is a single catalog push.
   */
  private async targets(
    menu: { id: string; brandId: string; locationId: string | null },
    channels: AutoPublishChannel[],
  ) {
    const rows: Array<{ channel: string; locationId: string; brandId: string; location?: { name: string } | null }> =
      await this.prisma.menuChannelAssignment.findMany({
        where: { menuId: menu.id, channel: { in: channels.filter((c) => c !== "HUBRISE") } },
        select: { channel: true, locationId: true, brandId: true, location: { select: { name: true } } },
      });
    const home = menu.locationId
      ? await this.prisma.location.findUnique({ where: { id: menu.locationId }, select: { name: true } })
      : null;

    const out: Partial<Record<AutoPublishChannel, Array<{ locationId: string | null; brandId: string | null; locationName: string | null }>>> = {};
    for (const channel of channels) {
      if (channel === "HUBRISE") {
        out[channel] = [{ locationId: menu.locationId, brandId: menu.brandId, locationName: home?.name ?? null }];
        continue;
      }
      const seen = new Set<string>();
      const list = rows
        .filter((r) => r.channel === channel)
        .filter((r) => (seen.has(r.locationId) ? false : (seen.add(r.locationId), true)))
        .map((r) => ({ locationId: r.locationId, brandId: r.brandId, locationName: r.location?.name ?? null }));
      out[channel] = list.length
        ? list
        : [{ locationId: menu.locationId, brandId: menu.brandId, locationName: home?.name ?? null }];
    }
    return out;
  }

  private async assertMenu(menuId: string, tenantId: string) {
    const menu = await this.prisma.menu.findFirst({
      where: { id: menuId, deletedAt: null, brand: { tenantId } },
      select: { id: true, name: true, brandId: true, locationId: true },
    });
    if (!menu) throw new NotFoundException("Menu not found");
    // Menu has a bare locationId (no relation) — the times are local to it.
    const loc = menu.locationId
      ? await this.prisma.location.findUnique({ where: { id: menu.locationId }, select: { country: true } })
      : null;
    return { ...menu, timezone: timezoneForCountry(loc?.country) };
  }

  private toDto(row: any) {
    return {
      id: row.id,
      menuId: row.menuId,
      enabled: row.enabled,
      channels: row.channels,
      days: row.days,
      times: row.times,
      timezone: row.timezone,
      nextRunAt: row.nextRunAt,
      lastRunAt: row.lastRunAt,
      lastStatus: row.lastStatus,
      lastResult: row.lastResult ?? null,
      updatedAt: row.updatedAt,
    };
  }
}
