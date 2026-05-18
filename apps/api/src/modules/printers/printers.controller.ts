import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
  Query,
  HttpCode,
  HttpStatus,
  ParseUUIDPipe,
} from "@nestjs/common";
import { ApiTags, ApiOperation, ApiBearerAuth } from "@nestjs/swagger";
import { PrintersService } from "./printers.service";
import { PrintQueueService } from "./print-queue.service";
import { CurrentUser } from "../../common/decorators/current-user.decorator";
import { Roles } from "../../common/decorators/roles.decorator";
import type { AuthenticatedUser } from "../auth/interfaces/jwt-payload.interface";

@ApiTags("printers")
@ApiBearerAuth()
@Controller({ path: "printers", version: "1" })
export class PrintersController {
  constructor(
    private readonly printers: PrintersService,
    private readonly printQueue: PrintQueueService,
  ) {}

  @Get()
  @ApiOperation({ summary: "List printers for a location" })
  findAll(
    @CurrentUser() user: AuthenticatedUser,
    @Query("locationId") locationId: string,
  ) {
    return this.printers.findByLocation(locationId, user.tenantId);
  }

  @Post()
  @Roles("MANAGER", "TENANT_OWNER", "PLATFORM_ADMIN")
  @ApiOperation({ summary: "Register a printer" })
  create(
    @CurrentUser() user: AuthenticatedUser,
    @Query("locationId") locationId: string,
    @Body() body: any,
  ) {
    return this.printers.create(locationId, user.tenantId, body);
  }

  @Patch(":id")
  @Roles("MANAGER", "TENANT_OWNER", "PLATFORM_ADMIN")
  @ApiOperation({ summary: "Update printer configuration" })
  update(
    @Param("id", ParseUUIDPipe) id: string,
    @Body() body: any,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.printers.update(id, user.tenantId, body);
  }

  @Delete(":id")
  @Roles("MANAGER", "TENANT_OWNER", "PLATFORM_ADMIN")
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: "Remove a printer" })
  remove(
    @Param("id", ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.printers.delete(id, user.tenantId);
  }

  @Get(":id/jobs")
  @ApiOperation({ summary: "Get recent print jobs for a printer" })
  getJobs(
    @Param("id", ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.printers.getJobs(id, user.tenantId);
  }

  @Post(":id/jobs/:jobId/reprint")
  @Roles("CASHIER", "MANAGER", "TENANT_OWNER", "PLATFORM_ADMIN")
  @ApiOperation({ summary: "Reprint a job" })
  reprint(@Param("jobId") jobId: string) {
    return this.printQueue.reprint(jobId);
  }
}
