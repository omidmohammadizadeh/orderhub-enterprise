import {
  Body,
  Controller,
  ForbiddenException,
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

  // The admin test hooks (activate / top-up for free) are PLATFORM_ADMIN only
  // by default — a tenant owner must NOT be able to grant themselves free
  // credits in production. Set VIDEO_STUDIO_TEST_MODE=true to also let a
  // TENANT_OWNER use them while testing before Stripe is wired.
  private testActivationAllowed(user: AuthenticatedUser): boolean {
    if (String(user.role) === "PLATFORM_ADMIN") return true;
    return (
      process.env.VIDEO_STUDIO_TEST_MODE === "true" &&
      String(user.role) === "TENANT_OWNER"
    );
  }

  @Get()
  @ApiOperation({ summary: "Video Studio status + credit balance" })
  async status(@CurrentUser() user: AuthenticatedUser) {
    const s = await this.studio.getStatus(user.tenantId);
    return { ...s, canTestActivate: this.testActivationAllowed(user) };
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

  @Post("generations/:id/cancel")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Cancel an in-flight generation and refund its credit" })
  cancel(@Param("id") id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.studio.cancelGeneration(id, user.tenantId);
  }

  // ── Admin/testing hooks (Stripe wiring replaces these in Phase 2) ─────────
  @Post("admin/activate")
  @Roles("PLATFORM_ADMIN", "TENANT_OWNER")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Activate the add-on for a tenant (grants allowance)" })
  activate(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: { tenantId?: string; includedMonthly?: number },
  ) {
    if (!this.testActivationAllowed(user)) {
      throw new ForbiddenException("Test activation is not enabled.");
    }
    // A TENANT_OWNER in test mode can only activate their OWN tenant.
    const tenantId =
      String(user.role) === "PLATFORM_ADMIN"
        ? body.tenantId ?? user.tenantId
        : user.tenantId;
    return this.studio.activateAddon(tenantId, {
      includedMonthly: body.includedMonthly ?? 15,
    });
  }

  @Post("admin/topup")
  @Roles("PLATFORM_ADMIN", "TENANT_OWNER")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Add top-up credits to a tenant" })
  topup(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: { tenantId?: string; credits?: number },
  ) {
    if (!this.testActivationAllowed(user)) {
      throw new ForbiddenException("Test top-up is not enabled.");
    }
    const tenantId =
      String(user.role) === "PLATFORM_ADMIN"
        ? body.tenantId ?? user.tenantId
        : user.tenantId;
    return this.studio.topup(tenantId, body.credits ?? 10);
  }
}
