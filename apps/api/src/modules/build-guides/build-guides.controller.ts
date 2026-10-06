import { Body, Controller, Get, Param, Put } from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";
import { CurrentUser } from "../../common/decorators/current-user.decorator";
import { Roles } from "../../common/decorators/roles.decorator";
import type { AuthenticatedUser } from "../auth/interfaces/jwt-payload.interface";
import { BuildGuidesService, type SaveBuildGuideInput } from "./build-guides.service";

@ApiTags("Build guides")
@ApiBearerAuth()
@Controller({ path: "build-guides", version: "1" })
export class BuildGuidesController {
  constructor(private readonly guides: BuildGuidesService) {}

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

  @Put("item/:itemId")
  @Roles("OWNER", "DARK_KITCHEN_MANAGER", "MANAGER", "TENANT_OWNER", "PLATFORM_ADMIN")
  @ApiOperation({ summary: "Save (or clear) a product's build guide — shared by every location of its brand" })
  async save(
    @Param("itemId") itemId: string,
    @Body() body: SaveBuildGuideInput,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return { guide: await this.guides.saveForItem(itemId, user.tenantId, body ?? {}, user.userId) };
  }
}
