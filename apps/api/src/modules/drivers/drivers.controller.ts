import {
  Controller,
  Get,
  Post,
  Patch,
  Body,
  Param,
  Query,
  HttpCode,
  HttpStatus,
} from "@nestjs/common";
import { ApiTags, ApiOperation, ApiBearerAuth } from "@nestjs/swagger";
import {
  DriversService,
  CreateDriverDto,
  UpdateDriverDto,
  AssignDriverDto,
  TrackingEventDto,
} from "./drivers.service";
import { CurrentUser } from "../../common/decorators/current-user.decorator";
import { Roles } from "../../common/decorators/roles.decorator";
import { Public } from "../../common/decorators/public.decorator";
import type { AuthenticatedUser } from "../auth/interfaces/jwt-payload.interface";

@ApiTags("drivers")
@ApiBearerAuth()
@Controller({ path: "drivers", version: "1" })
export class DriversController {
  constructor(private readonly drivers: DriversService) {}

  @Get()
  @ApiOperation({ summary: "List drivers" })
  findAll(
    @CurrentUser() user: AuthenticatedUser,
    @Query("activeOnly") activeOnly?: string,
    @Query("locationId") locationId?: string,
  ) {
    // Scope comes from the caller's own assignments; locationId is the Fleet
    // tab's shop picker and can only narrow it further.
    return this.drivers.findAll(user, {
      activeOnly: activeOnly !== "false",
      locationId,
    });
  }

  @Get(":driverId")
  @ApiOperation({ summary: "Get driver details with assignment history" })
  findOne(
    @Param("driverId") driverId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.drivers.findOne(driverId, user.tenantId);
  }

  @Post()
  @Roles("MANAGER", "TENANT_OWNER", "PLATFORM_ADMIN")
  @ApiOperation({ summary: "Create a driver" })
  create(
    @Body() dto: CreateDriverDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.drivers.create(user.tenantId, dto);
  }

  @Patch(":driverId")
  @Roles("MANAGER", "TENANT_OWNER", "PLATFORM_ADMIN")
  @ApiOperation({ summary: "Update driver" })
  update(
    @Param("driverId") driverId: string,
    @Body() dto: UpdateDriverDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.drivers.update(driverId, user.tenantId, dto);
  }

  @Patch(":driverId/presence")
  @Roles("MANAGER", "TENANT_OWNER", "PLATFORM_ADMIN", "OWNER")
  @ApiOperation({ summary: "Operator: toggle a driver online/offline" })
  setPresence(
    @Param("driverId") driverId: string,
    @Body() body: { online: boolean },
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.drivers.setPresence(user.tenantId, driverId, body.online);
  }

  @Post("assign")
  @Roles("MANAGER", "TENANT_OWNER", "PLATFORM_ADMIN")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Assign a driver to an order" })
  assign(
    @Body() dto: AssignDriverDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.drivers.assignDriver(user.tenantId, dto);
  }

  @Patch("orders/:orderId/status")
  @Roles("MANAGER", "TENANT_OWNER", "PLATFORM_ADMIN", "DRIVER")
  @ApiOperation({ summary: "Update delivery assignment status" })
  updateStatus(
    @Param("orderId") orderId: string,
    @Body() body: { status: "ACCEPTED" | "PICKED_UP" | "DELIVERED" | "CANCELLED" },
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.drivers.updateAssignmentStatus(orderId, user.tenantId, body.status);
  }

  @Post("orders/:orderId/tracking")
  @Roles("MANAGER", "TENANT_OWNER", "PLATFORM_ADMIN", "DRIVER")
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: "Record a driver GPS location event" })
  recordTracking(
    @Param("orderId") orderId: string,
    @Body() dto: TrackingEventDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.drivers.recordTracking(orderId, user.tenantId, dto);
  }

  @Get("orders/:orderId/tracking")
  @ApiOperation({ summary: "Get delivery tracking history for an order" })
  getTracking(
    @Param("orderId") orderId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.drivers.getTrackingHistory(orderId, user.tenantId);
  }
}
