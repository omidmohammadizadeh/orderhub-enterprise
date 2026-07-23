import { Module } from "@nestjs/common";
import { AgentController } from "./agent.controller";
import { AgentService } from "./agent.service";
import { MenusModule } from "../menus/menus.module";
import { InventoryModule } from "../inventory/inventory.module";
import { AuthModule } from "../auth/auth.module";

// Admin business co-pilot. Read tools use the global PrismaService directly;
// write tools call the validated services these modules export (MenusService +
// AiMenuImporter, MenuAvailabilityService, AuditLogService). Nothing imports
// AgentModule, so pulling these in creates no dependency cycle.
@Module({
  imports: [MenusModule, InventoryModule, AuthModule],
  controllers: [AgentController],
  providers: [AgentService],
  exports: [AgentService],
})
export class AgentModule {}
