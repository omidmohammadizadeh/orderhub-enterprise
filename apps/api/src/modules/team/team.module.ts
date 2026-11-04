import { Module } from "@nestjs/common";
import { TeamController } from "./team.controller";
import { TeamService } from "./team.service";
import { TeamInviteEmailService } from "./team-invite-email.service";
import { TabletLoginsController } from "./tablet-logins.controller";
import { TabletLoginsService } from "./tablet-logins.service";
import { LocationAccessService } from "../../common/access/location-access.service";

@Module({
  controllers: [TeamController, TabletLoginsController],
  providers: [
    TeamService,
    TeamInviteEmailService,
    TabletLoginsService,
    LocationAccessService,
  ],
  exports: [TeamService],
})
export class TeamModule {}
