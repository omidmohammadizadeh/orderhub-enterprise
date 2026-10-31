import { Body, Controller, Delete, Get, HttpCode, Param, Post, Put } from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";
import { Type } from "class-transformer";
import {
  IsArray,
  IsIn,
  IsInt,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from "class-validator";
import { Public } from "../../common/decorators/public.decorator";
import { CurrentUser } from "../../common/decorators/current-user.decorator";
import { Roles } from "../../common/decorators/roles.decorator";
import type { AuthenticatedUser } from "../auth/interfaces/jwt-payload.interface";
import { ProspectsService } from "./prospects.service";

class CreateProspectDto {
  @IsOptional() @IsString() @MaxLength(200) shopName?: string;
  @IsOptional() @IsString() @MaxLength(1000) sourceUrl?: string;
}

class ExtractedMenuDto {
  @IsObject() draft!: { categories?: unknown[]; [key: string]: unknown };
  @IsOptional() @IsString() @MaxLength(200) shopName?: string;
  @IsOptional() @IsString() @MaxLength(1000) logoUrl?: string | null;
  @IsOptional() @IsString() @MaxLength(1000) bannerUrl?: string | null;
  @IsOptional() @IsString() @MaxLength(100) city?: string | null;
  @IsOptional() @IsString() @MaxLength(12) postcode?: string | null;
}

class UploadFileDto {
  @IsOptional() @IsString() @MaxLength(100) mediaType?: string;
  @IsString() data!: string;
}

class UploadFilesDto {
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => UploadFileDto)
  files!: UploadFileDto[];
}

class HygieneLinkDto {
  @IsString() @MaxLength(500) url!: string;
}

class ManualFeeDto {
  @IsString() @MaxLength(100) label!: string;
  @IsNumber() @Min(0) amount!: number;
}

class ManualStatementDto {
  @IsIn(["just_eat", "uber_eats", "deliveroo", "other"]) platform!: string;
  @IsOptional() @Matches(/^\d{4}-\d{2}-\d{2}$/) periodStart?: string;
  @IsOptional() @Matches(/^\d{4}-\d{2}-\d{2}$/) periodEnd?: string;
  @IsNumber() @Min(0) sales!: number;
  @IsNumber() @Min(0) commission!: number;
  @IsOptional() @IsInt() @Min(0) orders?: number;
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ManualFeeDto)
  otherFees?: ManualFeeDto[];
}

class AssumptionsDto {
  @IsOptional() @IsNumber() @Min(0) @Max(100) movedSharePct?: number;
  @IsOptional() @IsNumber() @Min(0) @Max(100) cardPct?: number;
  @IsOptional() @IsNumber() @Min(0) cardFixedPence?: number;
  @IsOptional() @IsNumber() @Min(0) subscriptionPerWeek?: number;
  @IsOptional() @IsNumber() @Min(0) deliveryCostPerOrder?: number;
}

// PLATFORM_ADMIN only: this is our sales tool, and it holds other businesses'
// commission figures.
@ApiTags("Admin")
@ApiBearerAuth()
@Roles("PLATFORM_ADMIN")
@Controller({ path: "admin/prospects", version: "1" })
export class ProspectsController {
  constructor(private readonly prospects: ProspectsService) {}

  @Get()
  @ApiOperation({ summary: "Every prospect, newest first" })
  list() {
    return this.prospects.list();
  }

  @Post()
  @ApiOperation({ summary: "Start a prospect from a shop name or marketplace link" })
  create(@Body() dto: CreateProspectDto, @CurrentUser() user: AuthenticatedUser) {
    return this.prospects.create(dto.shopName, dto.sourceUrl, user.userId);
  }

  @Get(":id")
  @ApiOperation({ summary: "One prospect, with its commission report" })
  get(@Param("id") id: string) {
    return this.prospects.get(id);
  }

  @Delete(":id")
  @ApiOperation({ summary: "Delete a prospect, its preview and its statement figures" })
  remove(@Param("id") id: string) {
    return this.prospects.remove(id);
  }

  @Put(":id/menu")
  @ApiOperation({ summary: "Save a menu the browser read from a saved marketplace page" })
  saveMenu(@Param("id") id: string, @Body() dto: ExtractedMenuDto) {
    return this.prospects.saveExtractedMenu(id, dto);
  }

  @Post(":id/menu/read")
  @HttpCode(202)
  @ApiOperation({ summary: "Read a menu from a page, PDF or photo with AI, in the background" })
  readMenu(@Param("id") id: string, @Body() dto: UploadFilesDto) {
    return this.prospects.startMenuRead(id, dto.files);
  }

  @Put(":id/hygiene")
  @ApiOperation({ summary: "Set the FSA rating from a ratings.food.gov.uk link" })
  setHygiene(@Param("id") id: string, @Body() dto: HygieneLinkDto) {
    return this.prospects.setHygieneLink(id, dto.url);
  }

  @Post(":id/statements/read")
  @HttpCode(202)
  @ApiOperation({ summary: "Read marketplace statements with AI, in the background" })
  readStatements(@Param("id") id: string, @Body() dto: UploadFilesDto) {
    return this.prospects.startStatementRead(id, dto.files);
  }

  @Post(":id/statements")
  @ApiOperation({ summary: "Add a statement's figures by hand" })
  addStatement(@Param("id") id: string, @Body() dto: ManualStatementDto) {
    return this.prospects.addStatementByHand(id, dto);
  }

  @Delete(":id/statements/:statementId")
  @ApiOperation({ summary: "Remove one statement from the report" })
  removeStatement(@Param("id") id: string, @Param("statementId") statementId: string) {
    return this.prospects.removeStatement(id, statementId);
  }

  @Put(":id/assumptions")
  @ApiOperation({ summary: "Change the report's assumptions" })
  setAssumptions(@Param("id") id: string, @Body() dto: AssumptionsDto) {
    return this.prospects.setAssumptions(id, { ...dto });
  }
}

// The link the shop owner opens. No login, so it is the token that protects it.
@ApiTags("Public")
@Controller({ path: "public/prospect-preview", version: "1" })
export class PublicProspectPreviewController {
  constructor(private readonly prospects: ProspectsService) {}

  @Public()
  @Get(":token")
  @ApiOperation({ summary: "A shop's private menu preview" })
  preview(@Param("token") token: string) {
    return this.prospects.publicPreview(token);
  }
}
