import { Body, Controller, Get, Param, Post, HttpCode, HttpStatus } from "@nestjs/common";
import { ApiTags, ApiOperation, ApiBearerAuth } from "@nestjs/swagger";
import { ChatService } from "./chat.service";
import { CurrentUser } from "../../common/decorators/current-user.decorator";
import { Roles } from "../../common/decorators/roles.decorator";
import { Public } from "../../common/decorators/public.decorator";
import type { AuthenticatedUser } from "../auth/interfaces/jwt-payload.interface";

@ApiTags("chat")
@Controller({ path: "chat", version: "1" })
export class ChatController {
  constructor(private readonly chat: ChatService) {}

  // ── Operator side (authenticated) ───────────────────────────────────────────
  @Get("threads")
  @ApiBearerAuth()
  @Roles("MANAGER", "TENANT_OWNER", "PLATFORM_ADMIN", "OWNER", "DARK_KITCHEN_MANAGER")
  @ApiOperation({ summary: "Operator inbox: drivers with last message + unread count" })
  threads(@CurrentUser() user: AuthenticatedUser) {
    return this.chat.operatorThreads(user.tenantId);
  }

  @Get("driver/:driverId")
  @ApiBearerAuth()
  @Roles("MANAGER", "TENANT_OWNER", "PLATFORM_ADMIN", "OWNER", "DARK_KITCHEN_MANAGER")
  @ApiOperation({ summary: "Operator: full conversation with a driver (marks read)" })
  async driverThread(@CurrentUser() user: AuthenticatedUser, @Param("driverId") driverId: string) {
    const messages = await this.chat.driverThread(user.tenantId, driverId);
    await this.chat.readDriverThread(user.tenantId, driverId, "OPERATOR");
    return { messages };
  }

  @Post("driver/:driverId")
  @ApiBearerAuth()
  @Roles("MANAGER", "TENANT_OWNER", "PLATFORM_ADMIN", "OWNER", "DARK_KITCHEN_MANAGER")
  @ApiOperation({ summary: "Operator: send a message to a driver" })
  sendToDriver(
    @CurrentUser() user: AuthenticatedUser,
    @Param("driverId") driverId: string,
    @Body() body: { body: string },
  ) {
    return this.chat.postDriverOperator(user.tenantId, driverId, "OPERATOR", body.body, "Operator");
  }

  // ── Customer side (public, order-scoped by the hard-to-guess order id) ───────
  @Public()
  @Get("track/:orderId")
  @ApiOperation({ summary: "Customer: conversation with their driver for an order (marks read)" })
  async customerThread(@Param("orderId") orderId: string) {
    const messages = await this.chat.customerThread(orderId);
    await this.chat.readCustomerThread(orderId, "CUSTOMER");
    return { messages };
  }

  @Public()
  @Post("track/:orderId")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Customer: send a message to their driver" })
  sendToDriverFromCustomer(
    @Param("orderId") orderId: string,
    @Body() body: { body: string; name?: string },
  ) {
    return this.chat.postCustomerDriver(orderId, "CUSTOMER", body.body, body.name ?? "Customer");
  }
}
