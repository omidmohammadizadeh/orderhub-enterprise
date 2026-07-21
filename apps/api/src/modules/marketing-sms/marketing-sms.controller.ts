import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Query,
  Req,
  Res,
  Header,
  HttpCode,
  HttpStatus,
} from "@nestjs/common";
import { ApiTags, ApiOperation, ApiBearerAuth } from "@nestjs/swagger";
import type { Request, Response } from "express";
import { MarketingSmsService, ImportRow } from "./marketing-sms.service";
import { CurrentUser } from "../../common/decorators/current-user.decorator";
import { Roles } from "../../common/decorators/roles.decorator";
import { Public } from "../../common/decorators/public.decorator";
import type { AuthenticatedUser } from "../auth/interfaces/jwt-payload.interface";

// SMS marketing is a money feature — restricted to owners/admin/financial agent,
// NOT managers or general staff.
const MARKETING_ROLES = [
  "PLATFORM_ADMIN",
  "TENANT_OWNER",
  "OWNER",
  "FINANCIAL_AGENT",
] as const;

@ApiTags("marketing-sms")
@ApiBearerAuth()
@Controller({ path: "marketing-sms", version: "1" })
export class MarketingSmsController {
  constructor(private readonly svc: MarketingSmsService) {}

  // ── Contacts ────────────────────────────────────────────────────────────────

  @Get("channels")
  @Roles(...MARKETING_ROLES)
  @ApiOperation({ summary: "Channels available to import from, with contact counts" })
  channels(
    @CurrentUser() user: AuthenticatedUser,
    @Query("locationId") locationId?: string,
  ) {
    return this.svc.channelCounts(user.tenantId, locationId);
  }

  @Get("contacts")
  @Roles(...MARKETING_ROLES)
  contacts(
    @CurrentUser() user: AuthenticatedUser,
    @Query("consent") consent?: string,
    @Query("source") source?: string,
    @Query("search") search?: string,
    @Query("limit") limit?: string,
    @Query("locationId") locationId?: string,
  ) {
    return this.svc.listContacts(user.tenantId, {
      consent, source, search, locationId,
      limit: limit ? parseInt(limit, 10) : undefined,
    });
  }

  @Post("contacts/import-from-customers")
  @Roles(...MARKETING_ROLES)
  @ApiOperation({ summary: "Import contacts from the CRM by channel" })
  importFromCustomers(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: { sources: string[]; consentedOnly?: boolean; locationId?: string },
  ) {
    return this.svc.importFromCustomers(user.tenantId, {
      sources: body?.sources ?? [],
      consentedOnly: body?.consentedOnly,
      locationId: body?.locationId,
      createdBy: user.userId,
    });
  }

  @Post("contacts/import-rows")
  @Roles(...MARKETING_ROLES)
  @ApiOperation({ summary: "Import a parsed list (CSV/Excel/Sheet/paste)" })
  importRows(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: { rows: ImportRow[]; source?: string; assertConsent?: boolean; locationId?: string },
  ) {
    return this.svc.importRows(user.tenantId, body?.rows ?? [], {
      source: body?.source,
      assertConsent: !!body?.assertConsent,
      locationId: body?.locationId,
      createdBy: user.userId,
    });
  }

  @Post("contacts")
  @Roles(...MARKETING_ROLES)
  addManual(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: { phone: string; firstName?: string; lastName?: string; locationId?: string },
  ) {
    return this.svc.addManual(user.tenantId, { ...body, createdBy: user.userId });
  }

  @Patch("contacts/:id/consent")
  @Roles(...MARKETING_ROLES)
  setConsent(
    @CurrentUser() user: AuthenticatedUser,
    @Param("id") id: string,
    @Body() body: { status: "OPTED_IN" | "OPTED_OUT" },
  ) {
    return this.svc.setConsent(user.tenantId, id, body.status);
  }

  // ── Campaigns ────────────────────────────────────────────────────────────────

  @Get("campaigns")
  @Roles(...MARKETING_ROLES)
  listCampaigns(
    @CurrentUser() user: AuthenticatedUser,
    @Query("locationId") locationId?: string,
  ) {
    return this.svc.listCampaigns(user.tenantId, locationId);
  }

  @Get("campaigns/:id")
  @Roles(...MARKETING_ROLES)
  getCampaign(@CurrentUser() user: AuthenticatedUser, @Param("id") id: string) {
    return this.svc.getCampaign(user.tenantId, id);
  }

  @Post("campaigns")
  @Roles(...MARKETING_ROLES)
  upsertCampaign(
    @CurrentUser() user: AuthenticatedUser,
    @Body()
    body: {
      id?: string; name: string; senderHeader?: string; body: string;
      audience?: any; locationId?: string;
    },
  ) {
    return this.svc.createOrUpdateCampaign(user.tenantId, { ...body, createdBy: user.userId }, user.role);
  }

  @Post("preview")
  @Roles(...MARKETING_ROLES)
  @ApiOperation({ summary: "Live audience size + segment/cost estimate vs wallet" })
  preview(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: { senderHeader?: string; body: string; audience?: any; locationId?: string },
  ) {
    return this.svc.previewAudience(user.tenantId, {
      senderHeader: body?.senderHeader, body: body?.body ?? "",
      audience: body?.audience ?? {}, locationId: body?.locationId,
    });
  }

  @Post("test-send")
  @Roles(...MARKETING_ROLES)
  testSend(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: { phone: string; senderHeader?: string; body: string },
  ) {
    return this.svc.testSend(user.tenantId, { ...body, userId: user.userId });
  }

  @Post("campaigns/:id/send")
  @Roles("PLATFORM_ADMIN", "TENANT_OWNER", "OWNER", "FINANCIAL_AGENT")
  sendCampaign(@CurrentUser() user: AuthenticatedUser, @Param("id") id: string) {
    return this.svc.sendCampaign(user.tenantId, id, user.userId, user.role);
  }

  // ── Inbound STOP/START (Twilio) ───────────────────────────────────────────────

  @Post("inbound")
  @Public()
  @HttpCode(HttpStatus.OK)
  @Header("Content-Type", "text/xml")
  @ApiOperation({ summary: "Twilio inbound-SMS webhook — handles STOP/START opt-out" })
  async inbound(@Req() req: Request, @Res() res: Response) {
    // Twilio posts application/x-www-form-urlencoded { From, Body, ... }.
    const b: any = req.body ?? {};
    const from = b.From ?? b.from ?? "";
    const body = b.Body ?? b.body ?? "";
    try {
      if (from) await this.svc.handleInbound(String(from), String(body));
    } catch {
      /* never fail the webhook — Twilio would retry */
    }
    // Empty TwiML → no auto-reply (Twilio's own STOP confirmation still fires).
    res.send("<?xml version=\"1.0\" encoding=\"UTF-8\"?><Response></Response>");
  }
}
