import { Module, forwardRef } from '@nestjs/common';
import { UploadsModule } from "../uploads/uploads.module";
import { BullModule } from '@nestjs/bull';
import { MenusController } from './menus.controller';
import { MenusService } from './menus.service';
import { PluService } from './plu.service';
import { UberMenuImporter } from './importers/uber-menu.importer';
import { DeliverooMenuImporter } from './importers/deliveroo-menu.importer';
import { MenuWriterService } from './importers/menu-writer.service';
import { AiMenuParseService } from './importers/ai-menu.service';
import { AiMenuImporter } from './importers/ai-menu.importer';
import { HubRiseModule } from '../integrations/hubrise/hubrise.module';
import { DeliverooModule } from '../integrations/deliveroo/deliveroo.module';
import { UberEatsModule } from '../integrations/ubereats/ubereats.module';
import { InventoryModule } from '../inventory/inventory.module';
import { MenuAssignmentsModule } from './menu-assignments.module';
import { QUEUES } from '@orderhub/shared';

@Module({
  // HubRiseModule exports the catalog service used by the AW-11
  // /v1/menus/import/hubrise + /v1/menus/:id/publish/hubrise endpoints.
  // DeliverooModule exports DeliverooMenuPublishService for the direct
  // /v1/menus/:id/publish/deliveroo push (one-way import, no cycle).
  // InventoryModule provides MenuAvailabilityService — needed so the
  // POS menu strip-on-snooze in findActiveMenuForLocation resolves.
  // forwardRef breaks the InventoryModule → HubRise → Menus cycle.
  imports: [
    UploadsModule,
    BullModule.registerQueue({ name: QUEUES.MENU_SYNC }),
    HubRiseModule,
    DeliverooModule,
    UberEatsModule,
    forwardRef(() => InventoryModule),
    // Phase BA — serving-assignment resolver (cycle-free: only Prisma).
    MenuAssignmentsModule,
  ],
  controllers: [MenusController],
  providers: [
    MenusService,
    PluService,
    MenuWriterService,
    UberMenuImporter,
    DeliverooMenuImporter,
    AiMenuParseService,
    AiMenuImporter,
  ],
  exports: [
    MenusService,
    PluService,
    UberMenuImporter,
    DeliverooMenuImporter,
  ],
})
export class MenusModule {}
