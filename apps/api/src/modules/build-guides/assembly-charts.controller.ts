import { Body, Controller, Get, Param, Put } from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";
import { CurrentUser } from "../../common/decorators/current-user.decorator";
import { Roles } from "../../common/decorators/roles.decorator";
import type { AuthenticatedUser } from "../auth/interfaces/jwt-payload.interface";
import { AssemblyChartsService } from "./assembly-charts.service";

@ApiTags("Assembly charts")
@ApiBearerAuth()
@Controller({ path: "assembly-charts", version: "1" })
export class AssemblyChartsController {
  constructor(private readonly charts: AssemblyChartsService) {}

  @Get("keys")
  @ApiOperation({ summary: "Brand + product-name keys that have a chart (button visibility)" })
  keys(@CurrentUser() user: AuthenticatedUser) {
    return this.charts.listKeys(user.tenantId);
  }

  @Get("all")
  @ApiOperation({ summary: "Every chart in the tenant (copy-from list)" })
  all(@CurrentUser() user: AuthenticatedUser) {
    return this.charts.list(user.tenantId);
  }

  @Get("order/:orderId")
  forOrder(@Param("orderId") orderId: string, @CurrentUser() user: AuthenticatedUser) {
    return this.charts.forOrder(orderId, user.tenantId);
  }

  @Get("menu/:menuId/print")
  forMenu(@Param("menuId") menuId: string, @CurrentUser() user: AuthenticatedUser) {
    return this.charts.forMenu(menuId, user.tenantId);
  }

  @Get("item/:itemId")
  getForItem(@Param("itemId") itemId: string, @CurrentUser() user: AuthenticatedUser) {
    return this.charts.getForItem(itemId, user.tenantId);
  }

  @Put("item/:itemId")
  @Roles("OWNER", "DARK_KITCHEN_MANAGER", "MANAGER", "TENANT_OWNER", "PLATFORM_ADMIN")
  @ApiOperation({ summary: "Save (or, with no layers, remove) a product's assembly chart" })
  async save(
    @Param("itemId") itemId: string,
    @Body() body: Record<string, unknown>,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return { chart: await this.charts.saveForItem(itemId, user.tenantId, body ?? {}, user.userId) };
  }
}
