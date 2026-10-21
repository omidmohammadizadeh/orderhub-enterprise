import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  MaxLength,
  Max,
  Min,
} from "class-validator";
import { Roles } from "../../common/decorators/roles.decorator";
import { CurrentUser } from "../../common/decorators/current-user.decorator";
import type { AuthenticatedUser } from "../auth/interfaces/jwt-payload.interface";
import { AutoDispatchService } from "./auto-dispatch.service";
import {
  AUTO_DISPATCH_PROVIDERS,
  AUTO_DISPATCH_STRATEGIES,
  AUTO_DISPATCH_TRIGGERS,
} from "./auto-dispatch.logic";

class UpdateRuleDto {
  @IsOptional() @IsString() @MaxLength(80) name?: string;
  @IsOptional() @IsBoolean() enabled?: boolean;
  @IsOptional() @IsInt() @Min(0) @Max(10000) priority?: number;
  @IsOptional() @IsString() locationId?: string | null;
  @IsOptional() @IsArray() @ArrayMaxSize(100) @IsString({ each: true }) brandIds?: string[];
  @IsOptional() @IsArray() @ArrayMaxSize(30) @IsString({ each: true }) channels?: string[];
  @IsOptional() @IsIn(AUTO_DISPATCH_STRATEGIES as unknown as string[]) strategy?: string;
  @IsOptional()
  @IsArray()
  @IsIn(AUTO_DISPATCH_PROVIDERS as unknown as string[], { each: true })
  providers?: string[];
  @IsOptional() @IsBoolean() fallback?: boolean;
  @IsOptional() @IsIn(AUTO_DISPATCH_TRIGGERS as unknown as string[]) trigger?: string;
  @IsOptional() @IsInt() @Min(0) @Max(240) delayMinutes?: number;
  @IsOptional() @IsInt() @Min(0) maxPriceMinor?: number | null;
  @IsOptional() @IsBoolean() dryRun?: boolean;
}

class CreateRuleDto extends UpdateRuleDto {
  @IsString() @MaxLength(80) declare name: string;
  @IsIn(AUTO_DISPATCH_STRATEGIES as unknown as string[]) declare strategy: string;
  @IsArray()
  @IsIn(AUTO_DISPATCH_PROVIDERS as unknown as string[], { each: true })
  declare providers: string[];
  @IsIn(AUTO_DISPATCH_TRIGGERS as unknown as string[]) declare trigger: string;
}

// Admin Dashboard → Auto dispatch.
//
// PLATFORM_ADMIN only for now: a rule books real couriers and spends real
// wallet money on its own, so it stays with the platform team until it has
// run on our own shops for a while.
@ApiTags("Admin")
@ApiBearerAuth()
@Roles("PLATFORM_ADMIN")
@Controller({ path: "admin/auto-dispatch", version: "1" })
export class AutoDispatchController {
  constructor(private readonly svc: AutoDispatchService) {}

  @Get("options")
  @ApiOperation({ summary: "Locations (with provider readiness), brands and channels for the rule editor" })
  options(@CurrentUser() user: AuthenticatedUser) {
    return this.svc.options(user.tenantId);
  }

  @Get("rules")
  listRules(@CurrentUser() user: AuthenticatedUser) {
    return this.svc.listRules(user.tenantId);
  }

  @Post("rules")
  createRule(@Body() dto: CreateRuleDto, @CurrentUser() user: AuthenticatedUser) {
    return this.svc.createRule(user.tenantId, user.userId ?? null, dto);
  }

  @Patch("rules/:id")
  updateRule(
    @Param("id") id: string,
    @Body() dto: UpdateRuleDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.svc.updateRule(user.tenantId, id, dto);
  }

  @Delete("rules/:id")
  deleteRule(@Param("id") id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.svc.deleteRule(user.tenantId, id);
  }

  @Get("runs")
  listRuns(@Query("limit") limit: string | undefined, @CurrentUser() user: AuthenticatedUser) {
    return this.svc.listRuns(user.tenantId, Number(limit) || 50);
  }

  @Get("orders")
  @ApiOperation({ summary: "Recent delivery orders for the live-quote tester" })
  recentOrders(@CurrentUser() user: AuthenticatedUser) {
    return this.svc.recentOrders(user.tenantId);
  }

  @Post("orders/:orderId/preview")
  @ApiOperation({ summary: "Live quotes from every provider + what auto dispatch would pick. Books nothing." })
  preview(@Param("orderId") orderId: string, @CurrentUser() user: AuthenticatedUser) {
    return this.svc.preview(user.tenantId, orderId);
  }
}
