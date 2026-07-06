// Phase BA — tiny standalone module for the assignment resolver so that
// Menus, Ordering, WhatsApp, Inventory and the marketplace integration
// modules can all import it without creating module cycles (PrismaService
// is @Global via DatabaseModule, so no imports needed here).

import { Module } from "@nestjs/common";
import { MenuAssignmentsService } from "./menu-assignments.service";

@Module({
  providers: [MenuAssignmentsService],
  exports: [MenuAssignmentsService],
})
export class MenuAssignmentsModule {}
