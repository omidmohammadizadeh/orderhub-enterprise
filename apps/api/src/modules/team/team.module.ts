import { Module } from "@nestjs/common";
import { TeamController } from "./team.controller";
import { TeamService } from "./team.service";
import { TeamInviteEmailService } from "./team-invite-email.service";

@Module({
  controllers: [TeamController],
  providers: [TeamService, TeamInviteEmailService],
  exports: [TeamService],
})
export class TeamModule {}
