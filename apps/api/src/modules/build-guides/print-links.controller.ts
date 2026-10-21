import { BadRequestException, Body, Controller, Get, GoneException, Param, Post } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";
import { CurrentUser } from "../../common/decorators/current-user.decorator";
import { Public } from "../../common/decorators/public.decorator";
import type { AuthenticatedUser } from "../auth/interfaces/jwt-payload.interface";
import { AssemblyChartsService } from "./assembly-charts.service";
import { BuildGuidesService } from "./build-guides.service";
import { isPrintLinkKind, makePrintToken, readPrintToken } from "./print-links";

@ApiTags("Print links")
@ApiBearerAuth()
@Controller({ path: "print-links", version: "1" })
export class PrintLinksController {
  constructor(
    private readonly config: ConfigService,
    private readonly charts: AssemblyChartsService,
    private readonly guides: BuildGuidesService,
  ) {}

  private secret(): string {
    return String(this.config.get("JWT_SECRET") ?? "");
  }

  @Post()
  @ApiOperation({ summary: "Mint a short-lived link that opens a print page without signing in" })
  create(@Body() body: { kind?: unknown; id?: unknown }, @CurrentUser() user: AuthenticatedUser) {
    if (!isPrintLinkKind(body?.kind) || typeof body?.id !== "string" || !body.id) {
      throw new BadRequestException("kind and id are required");
    }
    return { token: makePrintToken(this.secret(), { kind: body.kind, id: body.id, tenantId: user.tenantId }) };
  }

  @Public()
  @Get(":token")
  @ApiOperation({ summary: "What a print link shows — the same data as the signed-in print endpoint" })
  async read(@Param("token") token: string) {
    const c = readPrintToken(this.secret(), token);
    if (!c) throw new GoneException("This link has expired. Open it again from Kitchen training.");
    switch (c.kind) {
      case "charts-menu":
        return this.charts.forMenu(c.id, c.tenantId);
      case "charts-item":
        return this.charts.getForItem(c.id, c.tenantId);
      case "guides-menu":
        return this.guides.forMenu(c.id, c.tenantId);
      case "guides-item":
        return this.guides.forItemPrint(c.id, c.tenantId);
      case "presentation":
        return this.charts.presentation(c.id, c.tenantId);
    }
  }
}
