import { Body, Controller, Delete, Get, Param, Patch, Post, Put, Query } from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";
import { CurrentUser } from "../../common/decorators/current-user.decorator";
import { Roles } from "../../common/decorators/roles.decorator";
import type { AuthenticatedUser } from "../auth/interfaces/jwt-payload.interface";
import { type CampaignInput, PushCampaignsService } from "./push-campaigns.service";

// Push is free to send, but a campaign reaches every customer who said yes to
// offers — the same reach as an SMS or email blast — so it gets the same
// roles: owners, admins and the financial agent, not shift managers.
const MARKETING_ROLES = ["PLATFORM_ADMIN", "TENANT_OWNER", "OWNER", "FINANCIAL_AGENT"] as const;

@ApiTags("push-notifications")
@ApiBearerAuth()
@Controller({ path: "push-notifications", version: "1" })
export class PushAdminController {
  constructor(private readonly svc: PushCampaignsService) {}

  @Get("overview")
  @Roles(...MARKETING_ROLES)
  @ApiOperation({ summary: "Subscriber counts, brands and shops for the Push notifications page" })
  overview(@CurrentUser() user: AuthenticatedUser) {
    return this.svc.overview(user.tenantId);
  }

  @Get("automations")
  @Roles(...MARKETING_ROLES)
  automations(@CurrentUser() user: AuthenticatedUser) {
    return this.svc.listAutomations(user.tenantId);
  }

  @Put("automations/:trigger")
  @Roles(...MARKETING_ROLES)
  @ApiOperation({ summary: "Switch an order-stage push on/off or change its wording" })
  saveAutomation(
    @CurrentUser() user: AuthenticatedUser,
    @Param("trigger") trigger: string,
    @Body() body: { enabled?: boolean; title?: string | null; body?: string | null; delayMinutes?: number | null },
  ) {
    return this.svc.saveAutomation(user.tenantId, trigger, body ?? {});
  }

  @Get("audience")
  @Roles(...MARKETING_ROLES)
  audience(
    @CurrentUser() user: AuthenticatedUser,
    @Query("locationId") locationId?: string,
    @Query("brandId") brandId?: string,
  ) {
    return this.svc.audienceCount(user.tenantId, { locationId, brandId });
  }

  @Get("campaigns")
  @Roles(...MARKETING_ROLES)
  campaigns(@CurrentUser() user: AuthenticatedUser) {
    return this.svc.listCampaigns(user.tenantId);
  }

  @Post("campaigns")
  @Roles(...MARKETING_ROLES)
  createCampaign(@CurrentUser() user: AuthenticatedUser, @Body() body: CampaignInput) {
    return this.svc.createCampaign(user.tenantId, user.userId, body ?? ({} as CampaignInput));
  }

  @Patch("campaigns/:id")
  @Roles(...MARKETING_ROLES)
  updateCampaign(
    @CurrentUser() user: AuthenticatedUser,
    @Param("id") id: string,
    @Body() body: CampaignInput,
  ) {
    return this.svc.updateCampaign(user.tenantId, id, body ?? ({} as CampaignInput));
  }

  @Post("campaigns/:id/send")
  @Roles(...MARKETING_ROLES)
  @ApiOperation({ summary: "Send now, or schedule with scheduledFor" })
  sendCampaign(
    @CurrentUser() user: AuthenticatedUser,
    @Param("id") id: string,
    @Body() body: { scheduledFor?: string | null },
  ) {
    return this.svc.scheduleCampaign(user.tenantId, id, body?.scheduledFor ?? null);
  }

  @Post("campaigns/:id/cancel")
  @Roles(...MARKETING_ROLES)
  cancelCampaign(@CurrentUser() user: AuthenticatedUser, @Param("id") id: string) {
    return this.svc.cancelCampaign(user.tenantId, id);
  }

  @Delete("campaigns/:id")
  @Roles(...MARKETING_ROLES)
  deleteCampaign(@CurrentUser() user: AuthenticatedUser, @Param("id") id: string) {
    return this.svc.deleteCampaign(user.tenantId, id);
  }
}
