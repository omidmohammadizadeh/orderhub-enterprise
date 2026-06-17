import { Module, forwardRef } from '@nestjs/common';
import { BullModule } from '@nestjs/bull';
import { MenusController } from './menus.controller';
import { MenusService } from './menus.service';
import { PluService } from './plu.service';
import { UberMenuImporter } from './importers/uber-menu.importer';
import { DeliverooMenuImporter } from './importers/deliveroo-menu.importer';
import { MenuWriterService } from './importers/menu-writer.service';
import { HubRiseModule } from '../integrations/hubrise/hubrise.module';
import { InventoryModule } from '../inventory/inventory.module';
import { QUEUES } from '@orderhub/shared';

@Module({
  // HubRiseModule exports the catalog service used by the AW-11
  // /v1/menus/import/hubrise + /v1/menus/:id/publish/hubrise endpoints.
  // InventoryModule provides MenuAvailabilityService — needed so the
  // POS menu strip-on-snooze in findActiveMenuForLocation resolves.
  // forwardRef breaks the InventoryModule → HubRise → Menus cycle.
  imports: [
    BullModule.registerQueue({ name: QUEUES.MENU_SYNC }),
    HubRiseModule,
    forwardRef(() => InventoryModule),
  ],
  controllers: [MenusController],
  providers: [
    MenusService,
    PluService,
    MenuWriterService,
    UberMenuImporter,
    DeliverooMenuImporter,
  ],
  exports: [
    MenusService,
    PluService,
    UberMenuImporter,
    DeliverooMenuImporter,
  ],
})
export class MenusModule {}
