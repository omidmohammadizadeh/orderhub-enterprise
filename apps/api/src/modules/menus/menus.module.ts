import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bull';
import { MenusController } from './menus.controller';
import { MenusService } from './menus.service';
import { PluService } from './plu.service';
import { UberMenuImporter } from './importers/uber-menu.importer';
import { DeliverooMenuImporter } from './importers/deliveroo-menu.importer';
import { MenuWriterService } from './importers/menu-writer.service';
import { QUEUES } from '@orderhub/shared';

@Module({
  imports: [BullModule.registerQueue({ name: QUEUES.MENU_SYNC })],
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
