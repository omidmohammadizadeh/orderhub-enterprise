import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bull';
import { MenusController } from './menus.controller';
import { MenusService } from './menus.service';
import { PluService } from './plu.service';
import { UberMenuImporter } from './importers/uber-menu.importer';
import { DeliverooMenuImporter } from './importers/deliveroo-menu.importer';
import { MenuWriterService } from './importers/menu-writer.service';
import { HubRiseModule } from '../integrations/hubrise/hubrise.module';
import { QUEUES } from '@orderhub/shared';

@Module({
  // HubRiseModule exports the catalog service used by the AW-11
  // /v1/menus/import/hubrise + /v1/menus/:id/publish/hubrise endpoints.
  imports: [
    BullModule.registerQueue({ name: QUEUES.MENU_SYNC }),
    HubRiseModule,
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
