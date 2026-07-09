import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
} from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";
import { CurrentUser } from "../../common/decorators/current-user.decorator";
import { Roles } from "../../common/decorators/roles.decorator";
import type { AuthenticatedUser } from "../auth/interfaces/jwt-payload.interface";
import { VideoStudioService, type GenerateVideoDto } from "./video-studio.service";

// Roles allowed to create videos (marketing-tier). Reads (status/list) are open
// to any authenticated user in the tenant.
const CREATE_ROLES = [
  "PLATFORM_ADMIN",
  "TENANT_OWNER",
  "OWNER",
  "DARK_KITCHEN_MANAGER",
  "MANAGER",
] as const;

@ApiTags("video-studio")
@ApiBearerAuth()
@Controller({ path: "video-studio", version: "1" })
export class VideoStudioController {
  constructor(private readonly studio: VideoStudioService) {}

  @Get()
  @ApiOperation({ summary: "Video Studio status + credit balance" })
  status(@CurrentUser() user: AuthenticatedUser) {
    return this.studio.getStatus(user.tenantId);
  }

  @Post("generate")
  @Roles(...CREATE_ROLES)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Generate a marketing video from a product photo" })
  generate(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: GenerateVideoDto,
  ) {
    return this.studio.generate(user, dto);
  }

  @Get("generations")
  @ApiOperation({ summary: "List recent video generations" })
  list(
    @CurrentUser() user: AuthenticatedUser,
    @Query("limit") limit?: string,
  ) {
    return this.studio.listGenerations(
      user.tenantId,
      limit ? parseInt(limit, 10) : 30,
    );
  }

  @Get("generations/:id")
  @ApiOperation({ summary: "Get a single generation (poll for status)" })
  get(@Param("id") id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.studio.getGeneration(id, user.tenantId);
  }

  // ── Admin/testing hooks (Stripe wiring replaces these in Phase 2) ─────────
  @Post("admin/activate")
  @Roles("PLATFORM_ADMIN")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Activate the add-on for a tenant (grants allowance)" })
  activate(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: { tenantId?: string; includedMonthly?: number },
  ) {
    return this.studio.activateAddon(body.tenantId ?? user.tenantId, {
      includedMonthly: body.includedMonthly ?? 15,
    });
  }

  @Post("admin/topup")
  @Roles("PLATFORM_ADMIN")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Add top-up credits to a tenant" })
  topup(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: { tenantId?: string; credits?: number },
  ) {
    return this.studio.topup(body.tenantId ?? user.tenantId, body.credits ?? 10);
  }
}
