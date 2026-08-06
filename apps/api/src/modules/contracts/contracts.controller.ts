import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  Res,
} from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";
import type { Response } from "express";
import { ContractsService } from "./contracts.service";
import { CurrentUser } from "../../common/decorators/current-user.decorator";
import { Roles } from "../../common/decorators/roles.decorator";
import type { AuthenticatedUser } from "../auth/interfaces/jwt-payload.interface";

// Operator-facing contract routes — PLATFORM_ADMIN only, set at the class so
// no route can be added later that quietly skips the gate. The counterparty's
// surface lives in ContractsPublicController and shares nothing with this one.

@ApiTags("contracts")
@ApiBearerAuth()
@Roles("PLATFORM_ADMIN")
@Controller({ path: "contracts", version: "1" })
export class ContractsController {
  constructor(private readonly contracts: ContractsService) {}

  // ── Templates ──────────────────────────────────────────────────────────

  @Get("templates")
  @ApiOperation({ summary: "List contract templates" })
  listTemplates(@CurrentUser() user: AuthenticatedUser) {
    return this.contracts.listTemplates(user.tenantId);
  }

  @Get("templates/starters")
  @ApiOperation({ summary: "Ready-made agreements available to install" })
  listStarters(@CurrentUser() user: AuthenticatedUser) {
    return this.contracts.listStarterTemplates(user.tenantId);
  }

  @Post("templates/starters/:key")
  @ApiOperation({ summary: "Copy a ready-made agreement into your templates" })
  installStarter(
    @CurrentUser() user: AuthenticatedUser,
    @Param("key") key: string,
  ) {
    return this.contracts.installStarterTemplate(user.tenantId, key, user.userId);
  }

  @Post("templates")
  @ApiOperation({ summary: "Create a contract template" })
  createTemplate(
    @CurrentUser() user: AuthenticatedUser,
    @Body()
    body: {
      name: string;
      description?: string;
      bodyHtml?: string;
      fileUrl?: string;
      fileName?: string;
      fileType?: string;
      subscriptionAmountPence?: number;
    },
  ) {
    return this.contracts.createTemplate(user.tenantId, body, user.userId);
  }

  @Patch("templates/:id")
  @ApiOperation({ summary: "Update a contract template" })
  updateTemplate(
    @CurrentUser() user: AuthenticatedUser,
    @Param("id") id: string,
    @Body() body: Record<string, any>,
  ) {
    return this.contracts.updateTemplate(user.tenantId, id, body);
  }

  @Delete("templates/:id")
  @ApiOperation({ summary: "Delete a contract template" })
  deleteTemplate(
    @CurrentUser() user: AuthenticatedUser,
    @Param("id") id: string,
  ) {
    return this.contracts.deleteTemplate(user.tenantId, id);
  }

  // ── Contracts ──────────────────────────────────────────────────────────

  @Get()
  @ApiOperation({ summary: "List contracts with their signing status" })
  list(
    @CurrentUser() user: AuthenticatedUser,
    @Query("status") status?: string,
  ) {
    return this.contracts.list(user.tenantId, status);
  }

  @Get(":id")
  @ApiOperation({ summary: "One contract plus its full audit trail" })
  get(@CurrentUser() user: AuthenticatedUser, @Param("id") id: string) {
    return this.contracts.get(user.tenantId, id);
  }

  @Post()
  @ApiOperation({ summary: "Draft a contract from a template or free content" })
  create(
    @CurrentUser() user: AuthenticatedUser,
    @Body()
    body: {
      templateId?: string;
      title?: string;
      bodyHtml?: string;
      fileUrl?: string;
      fileName?: string;
      fileType?: string;
      recipientName: string;
      recipientEmail: string;
      recipientCompany?: string;
      locationId?: string;
      subscriptionAmountPence?: number;
    },
  ) {
    return this.contracts.create(user.tenantId, body, user.userId);
  }

  @Get(":id/pdf")
  @ApiOperation({ summary: "Download the countersigned PDF" })
  async pdf(
    @CurrentUser() user: AuthenticatedUser,
    @Param("id") id: string,
    @Res() res: Response,
  ) {
    const { buffer, filename } = await this.contracts.pdfForAdmin(
      user.tenantId,
      id,
    );
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${filename}"`,
    );
    res.send(buffer);
  }

  @Post(":id/send")
  @ApiOperation({ summary: "Send (or resend) the signing link by email" })
  send(
    @CurrentUser() user: AuthenticatedUser,
    @Param("id") id: string,
    @Body() body: { emailIt?: boolean; message?: string } = {},
  ) {
    return this.contracts.send(user.tenantId, id, body);
  }

  @Post(":id/void")
  @ApiOperation({ summary: "Withdraw a contract that hasn't been signed" })
  void(
    @CurrentUser() user: AuthenticatedUser,
    @Param("id") id: string,
    @Body() body: { reason?: string } = {},
  ) {
    return this.contracts.void(user.tenantId, id, body.reason);
  }
}
