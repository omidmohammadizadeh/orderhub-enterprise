import { Body, Controller, Get, Param, Post } from "@nestjs/common";
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
@Roles("PLATFORM_ADMIN")
export class AgentController {
  constructor(private readonly agent: AgentService) {}

  @Get("status")
  @ApiOperation({ summary: "Whether the admin assistant is configured" })
  status() {
    return { configured: this.agent.configured };
  }

  // Start a chat turn as a background job (returns a jobId immediately). A
  // complex change can run past the proxy timeout — the client polls the GET
  // below instead of holding the request open.
  @Post("chat")
  @ApiOperation({ summary: "Start an admin-assistant chat turn — returns a jobId to poll" })
  chat(
    @Body() body: { messages: AgentChatTurn[] },
    @CurrentUser() user: AuthenticatedUser,
  ) {
    const jobId = this.agent.startChat(
      { tenantId: user.tenantId, userId: user.userId },
      body?.messages ?? [],
    );
    return { jobId };
  }

  @Get("chat/:jobId")
  @ApiOperation({ summary: "Poll a chat turn for its reply" })
  chatJob(@Param("jobId") jobId: string) {
    const job = this.agent.getChatJob(jobId);
    if (!job) {
      return { status: "failed", error: "This request expired — please ask again." };
    }
    return { status: job.status, reply: job.reply, toolsUsed: job.toolsUsed, error: job.error };
  }
}
