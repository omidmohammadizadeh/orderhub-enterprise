import { Module } from "@nestjs/common";
import { AgentController } from "./agent.controller";
import { AgentService } from "./agent.service";
import { AgentImageService } from "./agent-image.service";
import { SupabaseStorageService } from "../uploads/supabase-storage.service";
import { ReplicateProvider } from "../video-studio/replicate.provider";
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
  // ReplicateProvider only needs the global ConfigService, so it's provided
  // here directly rather than importing the whole VideoStudioModule.
  providers: [AgentService, AgentImageService, ReplicateProvider, SupabaseStorageService],
  exports: [AgentService],
})
export class AgentModule {}
