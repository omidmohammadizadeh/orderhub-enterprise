import { Body, Controller, Delete, Get, Param, Post, Put, Query } from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";
import { CurrentUser } from "../../common/decorators/current-user.decorator";
import { Roles } from "../../common/decorators/roles.decorator";
import type { AuthenticatedUser } from "../auth/interfaces/jwt-payload.interface";
import { BuildGuidesService, type SaveBuildGuideInput } from "./build-guides.service";
import { BuildStepLibraryService } from "./build-step-library.service";
import { BuildGuideTrainingService } from "./build-guide-training.service";
import { BuildGuideAiService } from "./build-guide-ai.service";

const EDITORS = ["OWNER", "DARK_KITCHEN_MANAGER", "MANAGER", "TENANT_OWNER", "PLATFORM_ADMIN"] as const;

@ApiTags("Build guides")
@ApiBearerAuth()
@Controller({ path: "build-guides", version: "1" })
export class BuildGuidesController {
  constructor(
    private readonly guides: BuildGuidesService,
    private readonly library: BuildStepLibraryService,
    private readonly training: BuildGuideTrainingService,
    private readonly ai: BuildGuideAiService,
  ) {}

  // ── Step library ───────────────────────────────────────────────────────────
  // Literal two-segment paths, declared before any :param route, so nothing
  // here can be swallowed by a parameterised handler.

  @Get("library/steps")
  @ApiOperation({ summary: "Reusable steps saved for this tenant" })
  listLibrary(@Query("q") q: string | undefined, @CurrentUser() user: AuthenticatedUser) {
    return this.library.list(user.tenantId, q);
  }

  @Post("library/steps")
  @Roles(...EDITORS)
  @ApiOperation({ summary: "Save a step to the reusable library" })
  addToLibrary(@Body() body: Record<string, unknown>, @CurrentUser() user: AuthenticatedUser) {
    return this.library.create(user.tenantId, body ?? {}, user.userId);
  }

  @Delete("library/steps/:id")
  @Roles(...EDITORS)
  removeFromLibrary(@Param("id") id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.library.remove(id, user.tenantId);
  }

  // ── Training mode ──────────────────────────────────────────────────────────

  @Get("training/overview")
  @ApiOperation({ summary: "Every guide with my training status and the team's trained count" })
  trainingOverview(@CurrentUser() user: AuthenticatedUser) {
    return this.training.overview(user.tenantId, user.userId);
  }

  @Get("training/guide/:guideId")
  trainingGuide(@Param("guideId") guideId: string, @CurrentUser() user: AuthenticatedUser) {
    return this.training.getGuide(guideId, user.tenantId);
  }

  @Post("training/guide/:guideId/complete")
  @ApiOperation({ summary: "Mark a guide as learned by the signed-in user" })
  completeTraining(@Param("guideId") guideId: string, @CurrentUser() user: AuthenticatedUser) {
    return this.training.complete(guideId, user.tenantId, user.userId);
  }

  @Get("training/guide/:guideId/staff")
  @Roles(...EDITORS)
  @ApiOperation({ summary: "Who has learned this guide" })
  whoTrained(@Param("guideId") guideId: string, @CurrentUser() user: AuthenticatedUser) {
    return this.training.whoTrained(guideId, user.tenantId);
  }

  // Read routes are open to every signed-in staff member — the kitchen reads
  // these from the order card and the KDS.
  @Get("keys")
  @ApiOperation({ summary: "Every brand + product-name key that has a guide (for button visibility)" })
  keys(@CurrentUser() user: AuthenticatedUser) {
    return this.guides.listKeys(user.tenantId);
  }

  @Get("order/:orderId")
  @ApiOperation({ summary: "The build guide for each line of an order" })
  forOrder(@Param("orderId") orderId: string, @CurrentUser() user: AuthenticatedUser) {
    return this.guides.forOrder(orderId, user.tenantId);
  }

  @Get("menu/:menuId/print")
  @ApiOperation({ summary: "Every guided product on a menu, by category — for A4 printing" })
  forMenu(@Param("menuId") menuId: string, @CurrentUser() user: AuthenticatedUser) {
    return this.guides.forMenu(menuId, user.tenantId);
  }

  @Get("item/:itemId/print")
  @ApiOperation({ summary: "One product's guide in the print shape" })
  forItemPrint(@Param("itemId") itemId: string, @CurrentUser() user: AuthenticatedUser) {
    return this.guides.forItemPrint(itemId, user.tenantId);
  }

  @Get("item/:itemId")
  @ApiOperation({ summary: "The build guide for a product (null when none)" })
  async getForItem(@Param("itemId") itemId: string, @CurrentUser() user: AuthenticatedUser) {
    return { guide: await this.guides.getForItem(itemId, user.tenantId) };
  }

  @Post("item/:itemId/ai-draft")
  @Roles(...EDITORS)
  @ApiOperation({ summary: "Draft a guide with AI from the product's name, photo and modifiers (not saved)" })
  aiDraft(@Param("itemId") itemId: string, @CurrentUser() user: AuthenticatedUser) {
    return this.ai.draft(itemId, user.tenantId);
  }

  @Put("item/:itemId")
  @Roles(...EDITORS)
  @ApiOperation({ summary: "Save (or clear) a product's build guide — shared by every location of its brand" })
  async save(
    @Param("itemId") itemId: string,
    @Body() body: SaveBuildGuideInput,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return { guide: await this.guides.saveForItem(itemId, user.tenantId, body ?? {}, user.userId) };
  }
}
