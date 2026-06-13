import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Optional,
  Param,
  Patch,
  Post,
  Query,
} from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";
import {
  CreateLeadDto,
  LeadsService,
  UpdateLeadDto,
} from "./leads.service";
import { CurrentUser } from "../../common/decorators/current-user.decorator";
import { Roles } from "../../common/decorators/roles.decorator";
import { Public } from "../../common/decorators/public.decorator";
import type { AuthenticatedUser } from "../auth/interfaces/jwt-payload.interface";

const VIEW_ROLES = ["PLATFORM_ADMIN", "ONBOARDING_AGENT"] as const;

@ApiTags("leads")
@Controller({ path: "leads", version: "1" })
export class LeadsController {
  constructor(private readonly leads: LeadsService) {}

  // Public submit — anonymous marketing-site form. The authenticated
  // no-access screen hits the same endpoint; if the JWT cookie is
  // present, the @CurrentUser decorator yields it and we tag the
  // submitter on the row, otherwise it's null and the lead is
  // anonymous.
  @Public()
  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: "Submit a contact / demo request (public)" })
  create(
    @Body() dto: CreateLeadDto,
    @CurrentUser() @Optional() user?: AuthenticatedUser,
  ) {
    return this.leads.create(dto, user?.userId);
  }

  @Get()
  @ApiBearerAuth()
  @Roles(...VIEW_ROLES)
  @ApiOperation({ summary: "List leads (admin / onboarding)" })
  list(
    @Query("status") status?: string,
    @Query("q") q?: string,
  ) {
    return this.leads.list({ status, q });
  }

  @Get("unread-count")
  @ApiBearerAuth()
  @Roles(...VIEW_ROLES)
  @ApiOperation({ summary: "Count of NEW leads — drives sidebar badge" })
  async unreadCount() {
    return { count: await this.leads.unreadCount() };
  }

  @Patch(":id")
  @ApiBearerAuth()
  @Roles(...VIEW_ROLES)
  @ApiOperation({ summary: "Update lead status or notes" })
  update(@Param("id") id: string, @Body() dto: UpdateLeadDto) {
    return this.leads.update(id, dto);
  }
}
