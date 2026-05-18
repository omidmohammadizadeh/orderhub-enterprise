import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bull';
import { MenusController } from './menus.controller';
import { MenusService } from './menus.service';
import { QUEUES } from '@orderhub/shared';

@Module({
  imports: [BullModule.registerQueue({ name: QUEUES.MENU_SYNC })],
  controllers: [MenusController],
  providers: [MenusService],
  exports: [MenusService],
})
export class MenusModule {}
