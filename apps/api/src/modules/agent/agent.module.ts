import { Module } from "@nestjs/common";
import { AgentController } from "./agent.controller";
import { AgentService } from "./agent.service";

// Admin business co-pilot (Phase 1, read-only). PrismaService is global
// (@Global DatabaseModule) so no imports are needed here.
@Module({
  controllers: [AgentController],
  providers: [AgentService],
  exports: [AgentService],
})
export class AgentModule {}
