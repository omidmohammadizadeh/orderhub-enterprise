import { Processor, Process, OnQueueFailed } from "@nestjs/bull";
import { Logger } from "@nestjs/common";
import type { Job } from "bull";
import axios from "axios";
import { QUEUES, MENU_JOBS } from "@orderhub/shared";
import { PrismaService } from "../infrastructure/prisma.service";
import { PlatformSyncFactory } from "../sync/platform-sync.factory";

interface PushToPlatformJobData {
  menuId: string;
  brandId: string;
  tenantId: string;
}

interface PullFromPlatformJobData {
  brandId: string;
  tenantId: string;
  platform: string;
  locationId: string;
}

@Processor(QUEUES.MENU_SYNC)
export class MenuSyncProcessor {
  private readonly logger = new Logger(MenuSyncProcessor.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly syncFactory: PlatformSyncFactory,
  ) {}

  @Process(MENU_JOBS.PUSH_TO_PLATFORM)
  async handlePushToPlatform(job: Job<PushToPlatformJobData>) {
    const { menuId, brandId, tenantId } = job.data;
    this.logger.log(`[menu:${menuId}] Pushing published menu to connected platforms`);

    // Find all active integrations for locations under this brand
    const integrations = await this.prisma.integration.findMany({
      where: {
        status: "ACTIVE",
        deletedAt: null,
        location: { brand: { id: brandId, tenantId } },
      },
      include: { location: { select: { id: true, name: true } } },
    });

    if (integrations.length === 0) {
      this.logger.debug(`[menu:${menuId}] No active integrations — skipping platform push`);
      return;
    }

    // Fetch the published menu data
    const menu = await (this.prisma as any).menu.findUnique({
      where: { id: menuId },
      include: {
        categories: {
          include: {
            items: {
              include: { modifierGroups: { include: { modifiers: true } } },
            },
          },
        },
      },
    });

    if (!menu) {
      this.logger.warn(`[menu:${menuId}] Menu not found — skipping platform push`);
      return;
    }

    const results: Array<{ platform: string; success: boolean; error?: string }> = [];

    for (const integration of integrations) {
      const credentials = integration.credentials as Record<string, string>;
      let success = false;
      let error: string | undefined;

      try {
        switch (integration.platform) {
          case "UBER_EATS":
            await this.syncMenuToUberEats(integration, menu, credentials);
            success = true;
            break;
          case "DELIVEROO":
            await this.syncMenuToDeliveroo(integration, menu, credentials);
            success = true;
            break;
          case "HUBRISE":
            await this.syncMenuToHubRise(integration, menu, credentials);
            success = true;
            break;
          case "JUST_EAT":
            await this.syncMenuToJustEat(integration, menu, credentials);
            success = true;
            break;
          default:
            this.logger.debug(
              `[menu:${menuId}] No menu sync handler for ${integration.platform} — skipping`,
            );
            continue;
        }
      } catch (err: any) {
        error = err?.response?.data?.message ?? String(err);
        this.logger.error(
          `[menu:${menuId}] Menu push to ${integration.platform} failed: ${error}`,
        );
      }

      await (this.prisma as any).integration
        .update({
          where: { id: integration.id },
          data: success
            ? { lastSyncAt: new Date(), lastError: null, lastErrorAt: null, status: "ACTIVE" }
            : { lastError: error, lastErrorAt: new Date(), status: "ERROR" },
        })
        .catch((updateErr: any) =>
          this.logger.error(`Failed to update integration status: ${updateErr.message}`),
        );

      results.push({ platform: integration.platform, success, error });
    }

    const succeeded = results.filter((r) => r.success).map((r) => r.platform);
    const failed = results.filter((r) => !r.success).map((r) => r.platform);
    if (succeeded.length > 0) {
      this.logger.log(`[menu:${menuId}] Menu pushed to: ${succeeded.join(", ")}`);
    }
    if (failed.length > 0) {
      this.logger.warn(`[menu:${menuId}] Menu push failed for: ${failed.join(", ")}`);
    }
  }

  // ── Platform-specific menu sync ───────────────────────────────────────────

  private async syncMenuToUberEats(
    integration: any,
    menuData: any,
    credentials: Record<string, string>,
  ): Promise<void> {
    const storeId = credentials.storeId;
    if (!storeId) throw new Error("Missing storeId in Uber Eats credentials");

    const normalised = this.normaliseMenuForUberEats(menuData);

    await axios.put(
      `https://api.uber.com/v2/eats/stores/${storeId}/menus`,
      normalised,
      {
        headers: {
          Authorization: `Bearer ${credentials.accessToken}`,
          "Content-Type": "application/json",
        },
        timeout: 10_000,
      },
    );
  }

  private async syncMenuToDeliveroo(
    integration: any,
    menuData: any,
    credentials: Record<string, string>,
  ): Promise<void> {
    const restaurantId = credentials.restaurantId;
    if (!restaurantId) throw new Error("Missing restaurantId in Deliveroo credentials");

    const normalised = this.normaliseMenuForDeliveroo(menuData);

    await axios.put(
      `https://api.deliveroo.com/menu-api/v1/restaurant/${restaurantId}/menu`,
      normalised,
      {
        headers: {
          Authorization: `Bearer ${credentials.accessToken}`,
          "Content-Type": "application/json",
        },
        timeout: 10_000,
      },
    );
  }

  private async syncMenuToHubRise(
    integration: any,
    menuData: any,
    credentials: Record<string, string>,
  ): Promise<void> {
    const { accountId, locationId: hubLocationId } = credentials;
    if (!accountId || !hubLocationId) {
      throw new Error("Missing accountId or locationId in HubRise credentials");
    }

    const normalised = this.normaliseMenuForHubRise(menuData);

    await axios.put(
      `https://api.hubrise.com/v1/accounts/${accountId}/locations/${hubLocationId}/catalog`,
      normalised,
      {
        headers: {
          "X-Access-Token": credentials.accessToken,
          "Content-Type": "application/json",
        },
        timeout: 10_000,
      },
    );
  }

  private async syncMenuToJustEat(
    integration: any,
    menuData: any,
    credentials: Record<string, string>,
  ): Promise<void> {
    const restaurantReference = credentials.restaurantReference;
    if (!restaurantReference) {
      throw new Error("Missing restaurantReference in Just Eat credentials");
    }

    const normalised = this.normaliseMenuForJustEat(menuData);

    await axios.post(
      `https://uk-api.just-eat.io/restaurants/${restaurantReference}/catalogue`,
      normalised,
      {
        headers: {
          Authorization: `Bearer ${credentials.accessToken}`,
          "Content-Type": "application/json",
          ...(credentials.applicationId
            ? { "x-je-application-id": credentials.applicationId }
            : {}),
        },
        timeout: 10_000,
      },
    );
  }

  // ── Menu normalisers ──────────────────────────────────────────────────────

  private normaliseMenuForUberEats(menu: any): object {
    return {
      menus: [
        {
          id: menu.id,
          title: { translations: { en: menu.name ?? "Menu" } },
          service_availability: [{ day_of_week: "monday", time_periods: [{ start_time: "00:00", end_time: "23:59" }] }],
          category_ids: (menu.categories ?? []).map((c: any) => c.id),
        },
      ],
      categories: (menu.categories ?? []).map((cat: any) => ({
        id: cat.id,
        title: { translations: { en: cat.name } },
        entities: (cat.items ?? []).map((item: any) => ({
          id: item.id,
          type: "ITEM",
        })),
      })),
      items: (menu.categories ?? []).flatMap((cat: any) =>
        (cat.items ?? []).map((item: any) => ({
          id: item.id,
          external_data: item.id,
          title: { translations: { en: item.name } },
          price_info: {
            price: Math.round((item.price ?? 0) * 100),
            currency_code: "GBP",
          },
          dish_info: {
            descriptions: { overview: { short_description: { translations: { en: item.description ?? "" } } } },
          },
          modifier_group_ids: (item.modifierGroups ?? []).map((mg: any) => ({ id: mg.id })),
        })),
      ),
      modifier_groups: (menu.categories ?? []).flatMap((cat: any) =>
        (cat.items ?? []).flatMap((item: any) =>
          (item.modifierGroups ?? []).map((mg: any) => ({
            id: mg.id,
            title: { translations: { en: mg.name } },
            quantity_info: { quantity: { min_permitted: mg.minSelectable ?? 0, max_permitted: mg.maxSelectable ?? 1 } },
            modifier_options: (mg.modifiers ?? []).map((m: any) => ({
              id: m.id,
              title: { translations: { en: m.name } },
              price_info: { price: Math.round((m.price ?? 0) * 100) },
            })),
          })),
        ),
      ),
    };
  }

  private normaliseMenuForDeliveroo(menu: any): object {
    return {
      name: menu.name ?? "Menu",
      categories: (menu.categories ?? []).map((cat: any) => ({
        name: cat.name,
        items: (cat.items ?? []).map((item: any) => ({
          pos_id: item.id,
          name: item.name,
          description: item.description ?? "",
          price: Math.round((item.price ?? 0) * 100),
          modifier_groups: (item.modifierGroups ?? []).map((mg: any) => ({
            name: mg.name,
            min_selection: mg.minSelectable ?? 0,
            max_selection: mg.maxSelectable ?? 1,
            options: (mg.modifiers ?? []).map((m: any) => ({
              pos_id: m.id,
              name: m.name,
              price: Math.round((m.price ?? 0) * 100),
            })),
          })),
        })),
      })),
    };
  }

  private normaliseMenuForHubRise(menu: any): object {
    return {
      categories: (menu.categories ?? []).map((cat: any) => ({
        ref: cat.id,
        name: cat.name,
        description: cat.description ?? null,
      })),
      products: (menu.categories ?? []).flatMap((cat: any) =>
        (cat.items ?? []).map((item: any) => ({
          ref: item.id,
          name: item.name,
          description: item.description ?? null,
          category_ref: cat.id,
          skus: [
            {
              ref: `${item.id}_default`,
              name: "Regular",
              price: `${(item.price ?? 0).toFixed(2)} GBP`,
            },
          ],
          option_list_refs: (item.modifierGroups ?? []).map((mg: any) => ({ ref: mg.id })),
        })),
      ),
      option_lists: (menu.categories ?? []).flatMap((cat: any) =>
        (cat.items ?? []).flatMap((item: any) =>
          (item.modifierGroups ?? []).map((mg: any) => ({
            ref: mg.id,
            name: mg.name,
            min_selections: mg.minSelectable ?? 0,
            max_selections: mg.maxSelectable ?? 1,
            options: (mg.modifiers ?? []).map((m: any) => ({
              ref: m.id,
              name: m.name,
              price: `${(m.price ?? 0).toFixed(2)} GBP`,
            })),
          })),
        ),
      ),
    };
  }

  private normaliseMenuForJustEat(menu: any): object {
    return {
      name: menu.name ?? "Menu",
      categories: (menu.categories ?? []).map((cat: any) => ({
        name: cat.name,
        description: cat.description ?? "",
        products: (cat.items ?? []).map((item: any) => ({
          sku: item.id,
          name: item.name,
          description: item.description ?? "",
          price: parseFloat((item.price ?? 0).toFixed(2)),
          productModifierGroups: (item.modifierGroups ?? []).map((mg: any) => ({
            name: mg.name,
            minSelection: mg.minSelectable ?? 0,
            maxSelection: mg.maxSelectable ?? 1,
            modifiers: (mg.modifiers ?? []).map((m: any) => ({
              sku: m.id,
              name: m.name,
              priceAdjustment: parseFloat((m.price ?? 0).toFixed(2)),
            })),
          })),
        })),
      })),
    };
  }

  @Process(MENU_JOBS.PULL_FROM_PLATFORM)
  async handlePullFromPlatform(job: Job<PullFromPlatformJobData>) {
    const { brandId, tenantId, platform, locationId } = job.data;
    this.logger.log(`[brand:${brandId}] Pulling menu from ${platform}`);

    const integration = await this.prisma.integration.findFirst({
      where: { locationId, platform: platform as any, status: "ACTIVE", deletedAt: null },
    });

    if (!integration) {
      this.logger.warn(`[brand:${brandId}] No active ${platform} integration at location:${locationId}`);
      return;
    }

    // Placeholder: actual catalogue pull requires platform-specific API clients.
    // This records the pull attempt in integration health.
    await this.prisma.integration.update({
      where: { id: integration.id },
      data: { lastSyncAt: new Date(), lastError: null },
    });

    this.logger.log(`[brand:${brandId}] Menu pull from ${platform} recorded`);
  }

  @OnQueueFailed()
  onFailed(job: Job, err: Error) {
    const data = job.data as PushToPlatformJobData;
    this.logger.error(
      `Menu sync job ${job.name}#${job.id} failed [menu:${data.menuId ?? "?"}] ` +
        `attempt ${job.attemptsMade}: ${err.message}`,
    );
  }
}
