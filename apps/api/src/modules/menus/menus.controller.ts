import {
  Controller,
  Get,
  Post,
  Patch,
  Put,
  Delete,
  Body,
  Param,
  Query,
  Res,
  HttpCode,
  HttpStatus,
  ParseUUIDPipe,
} from "@nestjs/common";
import type { Response } from "express";
import { SkipThrottle } from "@nestjs/throttler";
import sharp from "sharp";
import { Public } from "../../common/decorators/public.decorator";
import { ApiTags, ApiOperation, ApiBearerAuth, ApiQuery } from "@nestjs/swagger";
import { MenusService } from "./menus.service";
import { PluService } from "./plu.service";
import { UberMenuImporter } from "./importers/uber-menu.importer";
import { DeliverooMenuImporter } from "./importers/deliveroo-menu.importer";
import { AiMenuParseService, type AiMenuFile } from "./importers/ai-menu.service";
import { AiMenuImporter } from "./importers/ai-menu.importer";
import { MenuTranslationService } from "./menu-translation.service";
import type { AiMenuDraft } from "./importers/ai-menu.classifier";
import { HubRiseCatalogService } from "../integrations/hubrise/hubrise-catalog.service";
import { DeliverooMenuPublishService } from "../integrations/deliveroo/deliveroo-menu-publish.service";
import { UberEatsMenuPublishService } from "../integrations/ubereats/ubereats-menu-publish.service";
import { JetMenuPublishService } from "../integrations/jet/jet-menu-publish.service";
import {
  ApplyChannelPricingDto,
  CreateMenuDto,
  UpdateMenuDto,
  CreateMasterMenuDto,
  SetHubRiseCatalogMenusDto,
  CreateCategoryDto,
  UpdateCategoryDto,
  CreateMenuItemDto,
  UpdateMenuItemDto,
  AddItemToCategoryDto,
  ReorderDto,
  ApplyItemConfigDto,
} from "./dto/menu.dto";
import { CurrentUser } from "../../common/decorators/current-user.decorator";
import { Roles, TILL_ROLES } from "../../common/decorators/roles.decorator";
import type { AuthenticatedUser } from "../auth/interfaces/jwt-payload.interface";

/**
 * Resize an image buffer down to a small webp thumbnail when the caller
 * passed ?w=/?h= query params (Deliverect-style resizeImage proxy). Returns
 * null when no resize was requested (serve the original) or if the source
 * can't be decoded (e.g. an SVG/webp HubRise never returns) — in which case
 * the caller falls back to the original bytes so nothing ever 500s over a
 * thumbnail. Dimensions are clamped to a sane [8,1600] px window.
 */
async function resizeThumb(
  buffer: Buffer,
  w?: string,
  h?: string,
): Promise<Buffer | null> {
  const clamp = (v?: string): number | undefined => {
    const n = Number.parseInt(v ?? "", 10);
    if (!Number.isFinite(n) || n <= 0) return undefined;
    return Math.min(1600, Math.max(8, n));
  };
  const width = clamp(w);
  const height = clamp(h);
  if (!width && !height) return null;
  try {
    return await sharp(buffer)
      .rotate() // honour EXIF orientation before we drop the metadata
      .resize(width, height, { fit: "cover", withoutEnlargement: true })
      .webp({ quality: 72 })
      .toBuffer();
  } catch {
    return null;
  }
}

@ApiTags("menus")
@ApiBearerAuth()
@Controller({ version: "1" })
export class MenusController {
  constructor(
    private readonly menus: MenusService,
    private readonly plu: PluService,
    private readonly uberImporter: UberMenuImporter,
    private readonly deliverooImporter: DeliverooMenuImporter,
    private readonly aiParse: AiMenuParseService,
    private readonly aiImporter: AiMenuImporter,
    private readonly translation: MenuTranslationService,
    private readonly hubriseCatalog: HubRiseCatalogService,
    private readonly deliverooMenu: DeliverooMenuPublishService,
    private readonly uberEatsMenu: UberEatsMenuPublishService,
    private readonly jetMenu: JetMenuPublishService,
  ) {}

  // ── Phase AK — PLU + Imports ──────────────────────────────────────────────

  @Post("menus/generate-missing-plus")
  @Roles("OWNER", "DARK_KITCHEN_MANAGER", "MANAGER", "TENANT_OWNER", "PLATFORM_ADMIN")
  @ApiOperation({
    summary: "Generate PLUs for any product/group/option that's missing one",
  })
  generateMissingPlus(@CurrentUser() user: AuthenticatedUser) {
    return this.plu.generateMissingForTenant(user.tenantId);
  }

  @Post("menus/:menuId/import/uber")
  @Roles("OWNER", "DARK_KITCHEN_MANAGER", "MANAGER", "TENANT_OWNER", "PLATFORM_ADMIN")
  @ApiOperation({ summary: "Import Uber Eats menu into the selected menu" })
  importUber(
    @Param("menuId") menuId: string,
    @Body() body: { payload?: any; storeId?: string; accessToken?: string },
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.uberImporter.import({
      menuId,
      tenantId: user.tenantId,
      payload: body.payload,
      storeId: body.storeId,
      accessToken: body.accessToken,
    });
  }

  // ── AI menu import (upload a PDF/photo, AI builds the menu) ───────────

  // Parsing a big menu can take longer than the ~60s proxy timeout in front
  // of this API (a real 179-item saved Uber page took 67s; the server
  // finished with 201 but the browser had already been handed a 500). So the
  // parse runs as a background job: this POST returns a jobId immediately
  // and the client polls the GET below. No request ever runs long.
  @Post("brands/:brandId/menus/import/ai/parse")
  @Roles("OWNER", "DARK_KITCHEN_MANAGER", "MANAGER", "TENANT_OWNER", "PLATFORM_ADMIN")
  @ApiOperation({
    summary:
      "Start an AI parse of an uploaded menu (PDF/JPEG/PNG/HTML) — returns a jobId to poll; no DB writes",
  })
  parseAiMenu(
    @Param("brandId") _brandId: string,
    @Body() body: { files: AiMenuFile[] },
  ) {
    return { jobId: this.aiParse.startParse(body?.files) };
  }

  @Get("brands/:brandId/menus/import/ai/parse/:jobId")
  @Roles("OWNER", "DARK_KITCHEN_MANAGER", "MANAGER", "TENANT_OWNER", "PLATFORM_ADMIN")
  @ApiOperation({ summary: "Poll an AI menu-parse job for its result" })
  getAiParseJob(
    @Param("brandId") _brandId: string,
    @Param("jobId") jobId: string,
  ) {
    const job = this.aiParse.getJob(jobId);
    if (!job) {
      // Expired (15 min TTL) or unknown — tell the client to start over.
      return { status: "failed", error: "This import expired — please upload the file again." };
    }
    return { status: job.status, draft: job.draft, error: job.error };
  }

  @Post("brands/:brandId/menus/import/ai/commit")
  @Roles("OWNER", "DARK_KITCHEN_MANAGER", "MANAGER", "TENANT_OWNER", "PLATFORM_ADMIN")
  @ApiOperation({
    summary: "Create a menu from a reviewed AI-parsed draft",
  })
  commitAiMenu(
    @Param("brandId") brandId: string,
    @Body()
    body: {
      menuName?: string;
      menuType?: string;
      locationId?: string;
      draft: AiMenuDraft;
    },
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.aiImporter.commit({
      tenantId: user.tenantId,
      brandId,
      menuName: body?.menuName,
      menuType: body?.menuType,
      locationId: body?.locationId,
      draft: body?.draft,
    });
  }

  // ── Kitchen-ticket translation ────────────────────────────────────────
  //
  // Background job for the same reason the AI parse is one: a few hundred
  // names is several model calls, and a request held open that long is cut by
  // the proxy while the work succeeds.
  @Post("menus/:menuId/translate")
  @Roles("OWNER", "DARK_KITCHEN_MANAGER", "MANAGER", "TENANT_OWNER", "PLATFORM_ADMIN")
  @ApiOperation({
    summary:
      "Fill kitchen-language names across this menu's items, modifier groups and options",
  })
  startTranslate(
    @Param("menuId") menuId: string,
    @Body() body: { language?: string; overwrite?: boolean },
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return {
      jobId: this.translation.start({
        menuId,
        tenantId: user.tenantId,
        language: String(body?.language ?? "").trim(),
        overwrite: body?.overwrite === true,
      }),
    };
  }

  @Get("menus/:menuId/translate/:jobId")
  @Roles("OWNER", "DARK_KITCHEN_MANAGER", "MANAGER", "TENANT_OWNER", "PLATFORM_ADMIN")
  @ApiOperation({ summary: "Poll a menu translation job" })
  translateJob(@Param("jobId") jobId: string) {
    const job = this.translation.getJob(jobId);
    if (!job) return { status: "failed", error: "That translation expired" };
    return {
      status: job.status,
      translated: job.translated ?? 0,
      total: job.total ?? 0,
      result: job.result ?? null,
      error: job.error ?? null,
    };
  }

  // ── Phase AW-11 — HubRise catalog import + publish ────────────────────

  @Post("brands/:brandId/menus/import/hubrise")
  @Roles("OWNER", "DARK_KITCHEN_MANAGER", "MANAGER", "TENANT_OWNER", "PLATFORM_ADMIN")
  @ApiOperation({
    summary:
      "Import the location's HubRise catalog into a new (or existing) menu under this brand",
  })
  importHubRise(
    @Param("brandId") brandId: string,
    @Body() body: { locationId: string; catalogId?: string },
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.hubriseCatalog.importToMenu({
      tenantId: user.tenantId,
      brandId,
      locationId: body.locationId,
      catalogId: body.catalogId,
    });
  }

  // Phase AW-11.1 — public image proxy. Menu items imported from
  // HubRise carry imageUrl=/v1/menus/hubrise-image/<catalogId>/<imgId>;
  // this endpoint streams the image binary back so customers + POS
  // can render it without exposing the HubRise access token to the
  // browser. Public so unauthenticated storefront customers can see
  // the image; the catalog id + image id are opaque random tokens so
  // there's no enumeration risk.
  @Public()
  @SkipThrottle({ short: true, medium: true, webhook: true, login: true })
  @Get("menus/hubrise-image/:catalogId/:imageId")
  @ApiOperation({ summary: "Proxy a HubRise image to the browser" })
  async hubriseImage(
    @Param("catalogId") catalogId: string,
    @Param("imageId") imageId: string,
    @Res() res: Response,
    @Query("w") w?: string,
    @Query("h") h?: string,
  ) {
    const { buffer, contentType } = await this.hubriseCatalog.fetchHubRiseImage(
      catalogId,
      imageId,
    );
    // Like Deliverect's resizeImage proxy: when the caller asks for a
    // thumbnail (?w=&h=) we shrink server-side so the product list ships
    // ~1KB webp thumbnails instead of full-res photos — that's what keeps
    // the 500-image Products page from saturating the browser + limiter.
    const thumb = await resizeThumb(buffer, w, h);
    res.setHeader("Content-Type", thumb ? "image/webp" : contentType);
    // HubRise images are immutable per id, so let browsers + edge cache
    // hard. 30 days. The (w,h) live in the URL so each size caches apart.
    res.setHeader("Cache-Control", "public, max-age=2592000, immutable");
    res.send(thumb ?? buffer);
  }

  // Phase BA-5 — public menu cover-image proxy. Menu banners are stored as
  // inline data: URLs which Deliveroo (and other platforms) can't fetch, so
  // we decode + stream them here to give the menu a real, public https URL
  // for its cover photo. Public by opaque menu id, same as the HubRise proxy.
  @Public()
  @SkipThrottle({ short: true, medium: true, webhook: true, login: true })
  @Get("menus/:menuId/cover-image")
  @ApiOperation({ summary: "Proxy a menu's cover image (banner/logo)" })
  async menuCoverImage(
    @Param("menuId") menuId: string,
    @Res() res: Response,
    @Query("w") w?: string,
    @Query("h") h?: string,
  ) {
    const { buffer, contentType } = await this.menus.getMenuCoverImage(menuId);
    const thumb = await resizeThumb(buffer, w, h);
    res.setHeader("Content-Type", thumb ? "image/webp" : contentType);
    // The banner can change, so cache modestly rather than immutably.
    res.setHeader("Cache-Control", "public, max-age=3600");
    res.send(thumb ?? buffer);
  }

  @Post("menus/:menuId/publish/hubrise")
  @Roles("OWNER", "DARK_KITCHEN_MANAGER", "MANAGER", "TENANT_OWNER", "PLATFORM_ADMIN")
  @ApiOperation({
    summary:
      "Push this menu to HubRise as a catalog. Overwrites the location's existing catalog when one is already configured.",
  })
  publishHubRise(
    @Param("menuId") menuId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.hubriseCatalog.publishMenu({
      tenantId: user.tenantId,
      menuId,
    });
  }

  // Additive-publish counterpart: remove a menu from ONE channel at a
  // location without touching its other channels.
  @Post("menus/:menuId/unpublish-channel")
  @Roles("OWNER", "DARK_KITCHEN_MANAGER", "MANAGER", "TENANT_OWNER", "PLATFORM_ADMIN")
  @ApiOperation({
    summary: "Remove this menu from a single channel at a location",
  })
  unpublishFromChannel(
    @Param("menuId") menuId: string,
    @Body() body: { locationId: string; channel: string },
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.menus.unpublishFromChannel(
      menuId,
      user.tenantId,
      body.locationId,
      body.channel,
    );
  }

  @Post("menus/:menuId/publish/deliveroo")
  @Roles("OWNER", "DARK_KITCHEN_MANAGER", "MANAGER", "TENANT_OWNER", "PLATFORM_ADMIN")
  @ApiOperation({
    summary:
      "Push this menu directly to Deliveroo (create-or-update + publish) for the brand's connected Deliveroo store.",
  })
  publishDeliveroo(
    @Param("menuId") menuId: string,
    @CurrentUser() user: AuthenticatedUser,
    // Phase BA — multi-location menus publish once per selected location.
    @Body() body?: { locationId?: string },
  ) {
    return this.deliverooMenu.publishMenu({
      tenantId: user.tenantId,
      menuId,
      locationId: body?.locationId,
    });
  }

  @Post("menus/:menuId/publish/ubereats")
  @Roles("OWNER", "DARK_KITCHEN_MANAGER", "MANAGER", "TENANT_OWNER", "PLATFORM_ADMIN")
  @ApiOperation({
    summary:
      "Push this menu directly to Uber Eats (v2 upsert) for the brand's connected Uber Eats store.",
  })
  publishUberEats(
    @Param("menuId") menuId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Body() body?: { locationId?: string; brandId?: string },
  ) {
    return this.uberEatsMenu.publishMenu({
      tenantId: user.tenantId,
      menuId,
      locationId: body?.locationId,
      brandId: body?.brandId,
    });
  }

  @Post("menus/:menuId/publish/justeat")
  @Roles("OWNER", "DARK_KITCHEN_MANAGER", "MANAGER", "TENANT_OWNER", "PLATFORM_ADMIN")
  @ApiOperation({
    summary:
      "Push this menu directly to Just Eat (JET Connect) for the brand's connected restaurant. " +
      "Returns pending — JET's 202 only means the structure parsed; the real result arrives on the menu callback.",
  })
  publishJustEat(
    @Param("menuId") menuId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Body() body?: { locationId?: string; serviceTypes?: ("DELIVERY" | "COLLECTION")[] },
  ) {
    return this.jetMenu.publishMenu({
      tenantId: user.tenantId,
      menuId,
      locationId: body?.locationId,
      serviceTypes: body?.serviceTypes,
    });
  }

  @Post("menus/import/ubereats")
  @Roles("OWNER", "DARK_KITCHEN_MANAGER", "MANAGER", "TENANT_OWNER", "PLATFORM_ADMIN")
  @ApiOperation({
    summary:
      "Create a new menu for the brand/location and import it live from the brand's connected Uber Eats store (GET /v2/eats/stores/{id}/menus).",
  })
  importFromUberEats(
    @Body() body: { brandId: string; locationId: string },
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.uberImporter.importFromConnection({
      tenantId: user.tenantId,
      brandId: body.brandId,
      locationId: body.locationId,
    });
  }

  @Post("menus/import/deliveroo")
  @Roles("OWNER", "DARK_KITCHEN_MANAGER", "MANAGER", "TENANT_OWNER", "PLATFORM_ADMIN")
  @ApiOperation({
    summary:
      "Create a new menu for the brand/location and import it from the brand's connected Deliveroo store.",
  })
  importFromDeliveroo(
    @Body() body: { brandId: string; locationId: string },
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.deliverooImporter.importFromConnection({
      tenantId: user.tenantId,
      brandId: body.brandId,
      locationId: body.locationId,
    });
  }

  @Post("menus/:menuId/import/deliveroo")
  @Roles("OWNER", "DARK_KITCHEN_MANAGER", "MANAGER", "TENANT_OWNER", "PLATFORM_ADMIN")
  @ApiOperation({ summary: "Import Deliveroo menu into the selected menu" })
  importDeliveroo(
    @Param("menuId") menuId: string,
    @Body()
    body: {
      payload?: any;
      storeId?: string;
      deliverooBrandId?: string;
      accessToken?: string;
    },
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.deliverooImporter.import({
      menuId,
      tenantId: user.tenantId,
      payload: body.payload,
      storeId: body.storeId,
      deliverooBrandId: body.deliverooBrandId,
      accessToken: body.accessToken,
    });
  }

  // ── Location-scoped menu lookup (for POS) ─────────────────────────────────
  @Get("locations/:locationId/active-menu")
  @ApiOperation({
    summary: "Find the active menu for a location (used by the POS data load)",
  })
  findActiveMenuForLocation(
    @Param("locationId") locationId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.menus.findActiveMenuForLocation(locationId, user.tenantId);
  }

  // ── Menus ─────────────────────────────────────────────────────────────────

  @Get("brands/:brandId/menus")
  @ApiOperation({ summary: "List menus for a brand" })
  findAll(
    @Param("brandId") brandId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.menus.findAllByBrand(brandId, user.tenantId);
  }

  // Phase AP — operators wanted the Menu tab scoped to the location
  // they're currently working at, not their whole brand. This endpoint
  // returns ONLY the menus whose Menu.locationId matches.
  @Get("locations/:locationId/menus")
  @ApiOperation({ summary: "List menus for a single location" })
  findAllForLocation(
    @Param("locationId") locationId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.menus.findAllByLocation(locationId, user.tenantId);
  }

  // Phase AW-18 — operator picked "All locations" in the location
  // switcher. Return every menu they can see across every location
  // they have access to. Tenant-scoped via assertTenantAccess in
  // findAllForTenant + the user.userId filter for per-user location
  // restrictions.
  @Get("menus")
  @ApiOperation({ summary: "List every menu visible to the caller across all their locations" })
  findAllForTenant(@CurrentUser() user: AuthenticatedUser) {
    return this.menus.findAllForTenant(user.tenantId, user.userId);
  }

  @Get("menus/:menuId")
  @ApiOperation({ summary: "Get menu with categories and items" })
  findOne(
    @Param("menuId") menuId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.menus.findOne(menuId, user.tenantId);
  }

  @Post("brands/:brandId/menus")
  @Roles("OWNER", "DARK_KITCHEN_MANAGER", "MANAGER", "TENANT_OWNER", "PLATFORM_ADMIN")
  @ApiOperation({ summary: "Create a menu" })
  create(
    @Param("brandId") brandId: string,
    @Body() dto: CreateMenuDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.menus.create(brandId, user.tenantId, dto);
  }

  // Phase BC — Master Menu. Combines several existing menus at a location
  // (typically one per brand) into one new menu, so a single HubRise
  // connection (one menu per location) can carry every brand's catalog.
  @Post("locations/:locationId/menus/master")
  @Roles("OWNER", "DARK_KITCHEN_MANAGER", "MANAGER", "TENANT_OWNER", "PLATFORM_ADMIN")
  @ApiOperation({ summary: "Create a Master Menu combining several existing menus at a location" })
  createMasterMenu(
    @Param("locationId") locationId: string,
    @Body() dto: CreateMasterMenuDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.menus.createMasterMenu(locationId, user.tenantId, dto);
  }

  // Which of this location's menus make up its single HubRise catalog.
  // HubRise allows one catalog per location; naming the member menus here
  // replaces hand-building a Master Menu — publishing any member composes
  // them all, so every brand stays in the catalog whoever pressed publish.
  @Get("locations/:locationId/hubrise-catalog")
  @ApiOperation({ summary: "List this location's menus with their HubRise catalog membership" })
  listHubRiseCatalogMenus(
    @Param("locationId") locationId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.menus.listHubRiseCatalogMenus(locationId, user.tenantId);
  }

  @Put("locations/:locationId/hubrise-catalog")
  @Roles("OWNER", "DARK_KITCHEN_MANAGER", "MANAGER", "TENANT_OWNER", "PLATFORM_ADMIN")
  @ApiOperation({ summary: "Replace the set of menus composing this location's HubRise catalog" })
  setHubRiseCatalogMenus(
    @Param("locationId") locationId: string,
    @Body() dto: SetHubRiseCatalogMenusDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.menus.setHubRiseCatalogMenus(
      locationId,
      user.tenantId,
      dto.menuIds ?? [],
    );
  }

  @Patch("menus/:menuId")
  @Roles("OWNER", "DARK_KITCHEN_MANAGER", "MANAGER", "TENANT_OWNER", "PLATFORM_ADMIN")
  @ApiOperation({
    summary:
      "Update menu metadata. Phase BA: publishedTo + locationIds together rewrite the selected locations' serving assignments (replace semantics per slot).",
  })
  update(
    @Param("menuId") menuId: string,
    @Body() dto: UpdateMenuDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.menus.update(menuId, user.tenantId, dto, user.userId);
  }

  @Post("menus/:menuId/publish")
  @Roles("OWNER", "DARK_KITCHEN_MANAGER", "MANAGER", "TENANT_OWNER", "PLATFORM_ADMIN")
  @ApiOperation({ summary: "Publish a menu" })
  publish(
    @Param("menuId") menuId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.menus.publish(menuId, user.tenantId);
  }

  @Post("menus/:menuId/archive")
  @Roles("OWNER", "DARK_KITCHEN_MANAGER", "MANAGER", "TENANT_OWNER", "PLATFORM_ADMIN")
  @ApiOperation({ summary: "Archive a menu" })
  archive(
    @Param("menuId") menuId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.menus.archive(menuId, user.tenantId);
  }

  @Post("menus/:menuId/tag-brand")
  @Roles("OWNER", "DARK_KITCHEN_MANAGER", "MANAGER", "TENANT_OWNER", "PLATFORM_ADMIN")
  @ApiOperation({ summary: "Tag every item in a menu to a single brand" })
  tagBrand(
    @Param("menuId") menuId: string,
    @Body() body: { brandId: string },
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.menus.tagAllItemsBrand(menuId, user.tenantId, body.brandId);
  }

  // Give an imported menu's products refs of their own, so two brands whose
  // menus came out of the same HubRise catalog stop claiming the same ids.
  @Post("menus/:menuId/detach-from-import")
  @Roles("OWNER", "DARK_KITCHEN_MANAGER", "MANAGER", "TENANT_OWNER", "PLATFORM_ADMIN")
  @ApiOperation({
    summary:
      "Clear imported platform refs on this menu's products and mint fresh PLUs, so they no longer collide with another menu imported from the same catalog",
  })
  detachFromImport(
    @Param("menuId") menuId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.menus.detachMenuFromImport(menuId, user.tenantId);
  }

  @Post("menus/:menuId/clone")
  @Roles("OWNER", "DARK_KITCHEN_MANAGER", "MANAGER", "TENANT_OWNER", "PLATFORM_ADMIN")
  @ApiOperation({ summary: "Clone a menu to a new draft (optionally into another location)" })
  clone(
    @Param("menuId") menuId: string,
    @Body() body: { name: string; targetLocationId?: string },
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.menus.clone(menuId, user.tenantId, body.name, {
      targetLocationId: body.targetLocationId,
    });
  }

  @Delete("menus/:menuId")
  @Roles("OWNER", "DARK_KITCHEN_MANAGER", "MANAGER", "TENANT_OWNER", "PLATFORM_ADMIN")
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: "Soft-delete a menu" })
  remove(
    @Param("menuId") menuId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.menus.remove(menuId, user.tenantId);
  }

  // ── Categories ────────────────────────────────────────────────────────────

  @Post("menus/:menuId/categories")
  @Roles("OWNER", "DARK_KITCHEN_MANAGER", "MANAGER", "TENANT_OWNER", "PLATFORM_ADMIN")
  @ApiOperation({ summary: "Add a category to a menu" })
  createCategory(
    @Param("menuId") menuId: string,
    @Body() dto: CreateCategoryDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.menus.createCategory(menuId, user.tenantId, dto);
  }

  @Patch("categories/:categoryId")
  @Roles("OWNER", "DARK_KITCHEN_MANAGER", "MANAGER", "TENANT_OWNER", "PLATFORM_ADMIN")
  @ApiOperation({ summary: "Update a category" })
  updateCategory(
    @Param("categoryId") categoryId: string,
    @Body() dto: UpdateCategoryDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.menus.updateCategory(categoryId, user.tenantId, dto);
  }

  @Delete("categories/:categoryId")
  @Roles("OWNER", "DARK_KITCHEN_MANAGER", "MANAGER", "TENANT_OWNER", "PLATFORM_ADMIN")
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: "Remove a category" })
  removeCategory(
    @Param("categoryId") categoryId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.menus.removeCategory(categoryId, user.tenantId);
  }

  @Post("menus/:menuId/categories/reorder")
  @Roles("OWNER", "DARK_KITCHEN_MANAGER", "MANAGER", "TENANT_OWNER", "PLATFORM_ADMIN")
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: "Reorder categories" })
  reorderCategories(
    @Param("menuId") menuId: string,
    @Body() dto: ReorderDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.menus.reorderCategories(menuId, user.tenantId, dto);
  }

  // ── Items ─────────────────────────────────────────────────────────────────

  @Get("brands/:brandId/items")
  @ApiOperation({ summary: "List all items for a brand (item library)" })
  findItems(
    @Param("brandId") brandId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.menus.findItemsByBrand(brandId, user);
  }

  // Phase AW-12 — single-item hydration for the edit form. Previously
  // the product editor fetched the entire brand library and find()'d
  // by id; that breaks the moment the menu's brandId drifts from a
  // product's brandId (re-imported under a different brand, published
  // picker reassignment, etc). Tenant-scoped via the brand FK.
  @Get("items/:itemId")
  @ApiOperation({ summary: "Get a single menu item by id" })
  findItem(
    @Param("itemId") itemId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.menus.findItemById(itemId, user.tenantId);
  }

  // Phase AP — operators want the Products tab scoped to their selected
  // location, not the whole brand. Same pattern the Menu tab uses.
  @Get("locations/:locationId/items")
  @ApiOperation({ summary: "List items for a single location" })
  findItemsForLocation(
    @Param("locationId") locationId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.menus.findItemsByLocation(locationId, user);
  }

  @Post("brands/:brandId/items")
  @Roles("OWNER", "DARK_KITCHEN_MANAGER", "MANAGER", "TENANT_OWNER", "PLATFORM_ADMIN")
  @ApiOperation({ summary: "Create a menu item" })
  createItem(
    @Param("brandId") brandId: string,
    @Body() dto: CreateMenuItemDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.menus.createItem(brandId, user.tenantId, dto);
  }

  @Patch("items/:itemId")
  @Roles("OWNER", "DARK_KITCHEN_MANAGER", "MANAGER", "TENANT_OWNER", "PLATFORM_ADMIN")
  @ApiOperation({ summary: "Update a menu item" })
  updateItem(
    @Param("itemId") itemId: string,
    @Body() dto: UpdateMenuItemDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.menus.updateItem(itemId, user.tenantId, dto);
  }

  @Post("items/:itemId/apply-to")
  @Roles("OWNER", "DARK_KITCHEN_MANAGER", "MANAGER", "TENANT_OWNER", "PLATFORM_ADMIN")
  @ApiOperation({
    summary:
      "Apply this item's modifier groups and/or size set to other items",
  })
  applyItemConfig(
    @Param("itemId") itemId: string,
    @Body() dto: ApplyItemConfigDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.menus.applyItemConfigToItems(itemId, user.tenantId, dto);
  }

  @Post("items/:itemId/toggle-availability")
  @Roles(...TILL_ROLES)
  @ApiOperation({ summary: "Toggle item availability on/off" })
  toggleAvailability(
    @Param("itemId") itemId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.menus.toggleAvailability(itemId, user.tenantId);
  }

  @Delete("items/:itemId")
  @Roles("OWNER", "DARK_KITCHEN_MANAGER", "MANAGER", "TENANT_OWNER", "PLATFORM_ADMIN")
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: "Delete a menu item" })
  removeItem(
    @Param("itemId") itemId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.menus.removeItem(itemId, user.tenantId);
  }

  // ── Category ↔ Item links ─────────────────────────────────────────────────

  @Post("categories/:categoryId/items")
  @Roles("OWNER", "DARK_KITCHEN_MANAGER", "MANAGER", "TENANT_OWNER", "PLATFORM_ADMIN")
  @ApiOperation({ summary: "Add existing item to a category" })
  addItemToCategory(
    @Param("categoryId") categoryId: string,
    @Body() dto: AddItemToCategoryDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.menus.addItemToCategory(categoryId, user.tenantId, dto);
  }

  @Delete("categories/:categoryId/items/:itemId")
  @Roles("OWNER", "DARK_KITCHEN_MANAGER", "MANAGER", "TENANT_OWNER", "PLATFORM_ADMIN")
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: "Remove item from category" })
  removeItemFromCategory(
    @Param("categoryId") categoryId: string,
    @Param("itemId") itemId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.menus.removeItemFromCategory(categoryId, itemId, user.tenantId);
  }

  @Patch("categories/:categoryId/items/reorder")
  @Roles("OWNER", "DARK_KITCHEN_MANAGER", "MANAGER", "TENANT_OWNER", "PLATFORM_ADMIN")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Reorder items within a category" })
  reorderItems(
    @Param("categoryId") categoryId: string,
    @Body() body: { order: Array<{ itemId: string; sortOrder: number }> },
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.menus.reorderItemsInCategory(categoryId, user.tenantId, body.order);
  }

  // ── Bulk operations ───────────────────────────────────────────────────────

  @Post("items/bulk/availability")
  @Roles("OWNER", "DARK_KITCHEN_MANAGER", "MANAGER", "TENANT_OWNER", "PLATFORM_ADMIN")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Bulk toggle availability for multiple items" })
  bulkAvailability(
    @Body() body: { itemIds: string[]; isAvailable: boolean },
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.menus.bulkToggleAvailability(body.itemIds, user.tenantId, body.isAvailable);
  }

  @Post("items/bulk/price")
  @Roles("OWNER", "DARK_KITCHEN_MANAGER", "MANAGER", "TENANT_OWNER", "PLATFORM_ADMIN")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Bulk price adjustment" })
  bulkPrice(
    @Body() body: { itemIds: string[]; adjustment: { type: "fixed" | "percentage"; value: number } },
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.menus.bulkUpdatePrice(body.itemIds, user.tenantId, body.adjustment);
  }

  // ── Item variants ─────────────────────────────────────────────────────────

  @Post("items/:itemId/variants")
  @Roles("OWNER", "DARK_KITCHEN_MANAGER", "MANAGER", "TENANT_OWNER", "PLATFORM_ADMIN")
  @ApiOperation({ summary: "Add a size/variant to an item" })
  createVariant(
    @Param("itemId") itemId: string,
    @Body() dto: { name: string; price: number; sku?: string; sortOrder?: number },
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.menus.createVariant(itemId, user.tenantId, dto);
  }

  @Patch("items/variants/:variantId")
  @Roles("OWNER", "DARK_KITCHEN_MANAGER", "MANAGER", "TENANT_OWNER", "PLATFORM_ADMIN")
  @ApiOperation({ summary: "Update a variant" })
  updateVariant(
    @Param("variantId") variantId: string,
    @Body() dto: { name?: string; price?: number; sku?: string; sortOrder?: number; isAvailable?: boolean },
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.menus.updateVariant(variantId, user.tenantId, dto);
  }

  @Delete("items/variants/:variantId")
  @Roles("OWNER", "DARK_KITCHEN_MANAGER", "MANAGER", "TENANT_OWNER", "PLATFORM_ADMIN")
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: "Remove a variant" })
  removeVariant(
    @Param("variantId") variantId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.menus.removeVariant(variantId, user.tenantId);
  }

  // ── Menu versioning ───────────────────────────────────────────────────────

  @Get(":menuId/versions")
  @ApiOperation({ summary: "List menu version history" })
  getVersions(
    @Param("menuId") menuId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.menus.getVersions(menuId, user.tenantId);
  }

  @Post(":menuId/rollback/:versionId")
  @Roles("OWNER", "DARK_KITCHEN_MANAGER", "MANAGER", "TENANT_OWNER", "PLATFORM_ADMIN")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Rollback menu to a previous version" })
  rollback(
    @Param("menuId") menuId: string,
    @Param("versionId") versionId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.menus.rollback(menuId, versionId, user.tenantId);
  }

  // ── Modifier groups ───────────────────────────────────────────────────────

  @Get("brands/:brandId/modifier-groups")
  @ApiOperation({ summary: "List modifier groups for a brand" })
  listModifierGroups(
    @Param("brandId") brandId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.menus.findModifierGroupsByBrand(brandId, user);
  }

  // Phase AW-18.2 — single-row reads so the edit forms hydrate by
  // id instead of brand-list-then-find. Mirrors AW-12's items fix.
  @Get("modifier-groups/:groupId")
  @ApiOperation({ summary: "Get a single modifier group by id" })
  findModifierGroup(
    @Param("groupId") groupId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.menus.findModifierGroupById(groupId, user.tenantId);
  }

  @Get("modifier-options/:optionId")
  @ApiOperation({ summary: "Get a single modifier option by id" })
  findModifierOption(
    @Param("optionId") optionId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.menus.findModifierOptionById(optionId, user.tenantId);
  }

  // Phase AP — location-scoped modifier groups for the Products tab.
  @Get("locations/:locationId/modifier-groups")
  @ApiOperation({ summary: "List modifier groups for a single location" })
  listModifierGroupsForLocation(
    @Param("locationId") locationId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.menus.findModifierGroupsByLocation(locationId, user);
  }

  @Post("brands/:brandId/modifier-groups")
  @Roles("OWNER", "DARK_KITCHEN_MANAGER", "MANAGER", "TENANT_OWNER", "PLATFORM_ADMIN")
  @ApiOperation({ summary: "Create a modifier group" })
  createModifierGroup(
    @Param("brandId") brandId: string,
    @Body()
    dto: {
      name: string;
      description?: string;
      minSelections?: number;
      maxSelections?: number;
      isRequired?: boolean;
      // Phase AP — Products section is location-scoped.
      locationId?: string;
    },
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.menus.createModifierGroup(brandId, user.tenantId, dto);
  }

  @Patch("modifier-groups/:groupId")
  @Roles("OWNER", "DARK_KITCHEN_MANAGER", "MANAGER", "TENANT_OWNER", "PLATFORM_ADMIN")
  @ApiOperation({ summary: "Update a modifier group" })
  updateModifierGroup(
    @Param("groupId") groupId: string,
    @Body() dto: { name?: string; description?: string; minSelections?: number; maxSelections?: number | null; isRequired?: boolean },
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.menus.updateModifierGroup(groupId, user.tenantId, dto);
  }

  @Delete("modifier-groups/:groupId")
  @Roles("OWNER", "DARK_KITCHEN_MANAGER", "MANAGER", "TENANT_OWNER", "PLATFORM_ADMIN")
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: "Delete a modifier group" })
  removeModifierGroup(
    @Param("groupId") groupId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.menus.removeModifierGroup(groupId, user.tenantId);
  }

  @Post("modifier-groups/:groupId/duplicate")
  @Roles("OWNER", "DARK_KITCHEN_MANAGER", "MANAGER", "TENANT_OWNER", "PLATFORM_ADMIN")
  @ApiOperation({
    summary: "Deep-copy a modifier group and all of its modifiers",
  })
  duplicateModifierGroup(
    @Param("groupId") groupId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.menus.duplicateModifierGroup(groupId, user.tenantId);
  }

  @Post("modifier-options/:optionId/duplicate")
  @Roles("OWNER", "DARK_KITCHEN_MANAGER", "MANAGER", "TENANT_OWNER", "PLATFORM_ADMIN")
  @ApiOperation({ summary: "Copy a modifier within its group" })
  duplicateModifierOption(
    @Param("optionId") optionId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.menus.duplicateModifierOption(optionId, user.tenantId);
  }

  @Post("modifier-groups/:groupId/options")
  @Roles("OWNER", "DARK_KITCHEN_MANAGER", "MANAGER", "TENANT_OWNER", "PLATFORM_ADMIN")
  @ApiOperation({ summary: "Add an option to a modifier group" })
  addModifierOption(
    @Param("groupId") groupId: string,
    @Body() dto: { name: string; priceAdjustment?: number; isDefault?: boolean; imageUrl?: string; allergens?: string[]; nestedGroupId?: string; platformPricingOverrides?: Record<string, number> },
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.menus.addModifierOption(groupId, user.tenantId, dto);
  }

  @Patch("modifier-options/:optionId")
  @Roles("OWNER", "DARK_KITCHEN_MANAGER", "MANAGER", "TENANT_OWNER", "PLATFORM_ADMIN")
  @ApiOperation({ summary: "Update a modifier option" })
  updateModifierOption(
    @Param("optionId") optionId: string,
    @Body() dto: { name?: string; secondLanguageName?: string | null; priceAdjustment?: number; isDefault?: boolean; isAvailable?: boolean; imageUrl?: string; allergens?: string[]; nestedGroupId?: string | null; nestedGroupIds?: string[]; sortOrder?: number; platformPricingOverrides?: Record<string, number> },
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.menus.updateModifierOption(optionId, user.tenantId, dto);
  }

  @Delete("modifier-options/:optionId")
  @Roles("OWNER", "DARK_KITCHEN_MANAGER", "MANAGER", "TENANT_OWNER", "PLATFORM_ADMIN")
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: "Remove a modifier option" })
  removeModifierOption(
    @Param("optionId") optionId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.menus.removeModifierOption(optionId, user.tenantId);
  }

  // Attach/detach an EXISTING modifier option to a group via the
  // many-to-many modifierGroupIds[] array (primary FK group preserved).
  // The web "Add Existing" picker on the modifier-group editor calls these;
  // they were missing, so attaches 404'd and never persisted.
  @Post("modifier-groups/:groupId/modifiers/:modifierId")
  @Roles("OWNER", "DARK_KITCHEN_MANAGER", "MANAGER", "TENANT_OWNER", "PLATFORM_ADMIN")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Attach an existing modifier option to a group" })
  attachModifier(
    @Param("groupId") groupId: string,
    @Param("modifierId") modifierId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.menus.attachModifierToGroup(groupId, modifierId, user.tenantId);
  }

  @Delete("modifier-groups/:groupId/modifiers/:modifierId")
  @Roles("OWNER", "DARK_KITCHEN_MANAGER", "MANAGER", "TENANT_OWNER", "PLATFORM_ADMIN")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Detach an existing modifier option from a group" })
  detachModifier(
    @Param("groupId") groupId: string,
    @Param("modifierId") modifierId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.menus.detachModifierFromGroup(groupId, modifierId, user.tenantId);
  }

  // Declared ABOVE items/:itemId/modifier-groups/:groupId on purpose: Nest
  // matches in declaration order, so below it "reorder" is read as a groupId
  // and the call 404s as an unknown modifier group.
  @Post("items/:itemId/modifier-groups/reorder")
  @Roles("OWNER", "DARK_KITCHEN_MANAGER", "MANAGER", "TENANT_OWNER", "PLATFORM_ADMIN")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Set the order an item's modifier groups are asked for" })
  reorderItemModifierGroups(
    @Param("itemId") itemId: string,
    @Body() body: { groupIds?: string[] },
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.menus.reorderItemModifierGroups(
      itemId,
      body?.groupIds ?? [],
      user.tenantId,
    );
  }

  @Post("items/:itemId/modifier-groups/:groupId")
  @Roles("OWNER", "DARK_KITCHEN_MANAGER", "MANAGER", "TENANT_OWNER", "PLATFORM_ADMIN")
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: "Link a modifier group to an item" })
  linkModifierGroup(
    @Param("itemId") itemId: string,
    @Param("groupId") groupId: string,
    @Body() body: { sortOrder?: number },
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.menus.linkModifierGroupToItem(itemId, groupId, user.tenantId, body.sortOrder);
  }

  @Delete("items/:itemId/modifier-groups/:groupId")
  @Roles("OWNER", "DARK_KITCHEN_MANAGER", "MANAGER", "TENANT_OWNER", "PLATFORM_ADMIN")
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: "Unlink a modifier group from an item" })
  unlinkModifierGroup(
    @Param("itemId") itemId: string,
    @Param("groupId") groupId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.menus.unlinkModifierGroupFromItem(itemId, groupId, user.tenantId);
  }

  @Post("menus/:menuId/channel-pricing")
  @ApiOperation({
    summary:
      "Apply one percentage uplift per channel across every price in a menu",
  })
  applyChannelPricing(
    @Param("menuId") menuId: string,
    @Body() dto: ApplyChannelPricingDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.menus.applyChannelPricing(menuId, user.tenantId, dto);
  }

}
