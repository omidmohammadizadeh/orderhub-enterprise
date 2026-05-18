import {
  Controller,
  Post,
  Delete,
  Body,
  Req,
  ForbiddenException,
  UseGuards,
} from "@nestjs/common";
import { Roles } from "../../common/decorators/roles.decorator";
import { SandboxService } from "./sandbox.service";

interface AuthRequest extends Request {
  user: { tenantId: string; locationId?: string };
}

@Controller("v1/sandbox")
@Roles("OWNER", "MANAGER")
export class SandboxController {
  constructor(private readonly sandbox: SandboxService) {}

  @Post("generate-orders")
  generateOrders(
    @Req() req: AuthRequest,
    @Body() body: { count?: number; platform?: string; locationId?: string },
  ) {
    const { tenantId } = req.user;
    const locationId = body.locationId ?? req.user.locationId ?? "";
    return this.sandbox.generateOrders(
      tenantId,
      locationId,
      body.count ?? 5,
      body.platform ?? "UBER_EATS",
    );
  }

  @Post("rush-hour")
  rushHour(
    @Req() req: AuthRequest,
    @Body() body: { orderCount?: number; durationMinutes?: number; locationId?: string },
  ) {
    const { tenantId } = req.user;
    const locationId = body.locationId ?? req.user.locationId ?? "";
    return this.sandbox.rushHourSimulation(
      tenantId,
      locationId,
      body.orderCount ?? 15,
      body.durationMinutes ?? 5,
    );
  }

  @Post("replay-webhook")
  replayWebhook(@Body() body: { eventId: string }) {
    return this.sandbox.replayWebhook(body.eventId);
  }

  @Post("simulate-outage")
  simulateOutage(@Body() body: { platform: string; durationSeconds?: number }) {
    return this.sandbox.simulateOutage(body.platform, body.durationSeconds ?? 60);
  }

  @Delete("clear-orders")
  clearOrders(@Req() req: AuthRequest) {
    return this.sandbox.clearOrders(req.user.tenantId);
  }
}
