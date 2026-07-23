import { Body, Controller, Get, Post } from "@nestjs/common";
import { ApiTags, ApiOperation, ApiBearerAuth } from "@nestjs/swagger";
import { AgentService, type AgentChatTurn } from "./agent.service";
import { CurrentUser } from "../../common/decorators/current-user.decorator";
import { Roles } from "../../common/decorators/roles.decorator";
import type { AuthenticatedUser } from "../auth/interfaces/jwt-payload.interface";

// Admin-only. The agent is scoped to the caller's tenant inside the service —
// tenantId comes from the verified JWT, never from the request body.
@ApiTags("agent")
@ApiBearerAuth()
@Controller({ path: "agent", version: "1" })
@Roles("PLATFORM_ADMIN", "TENANT_OWNER", "OWNER")
export class AgentController {
  constructor(private readonly agent: AgentService) {}

  @Get("status")
  @ApiOperation({ summary: "Whether the admin assistant is configured" })
  status() {
    return { configured: this.agent.configured };
  }

  @Post("chat")
  @ApiOperation({
    summary: "Ask the read-only admin assistant a question about the business",
  })
  chat(
    @Body() body: { messages: AgentChatTurn[] },
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.agent.chat(user.tenantId, body?.messages ?? []);
  }
}
