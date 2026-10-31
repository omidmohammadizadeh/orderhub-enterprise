import { Module } from "@nestjs/common";
import { DatabaseModule } from "../../infrastructure/database/database.module";
import { MenusModule } from "../menus/menus.module";
import { ProspectsController, PublicProspectPreviewController } from "./prospects.controller";
import { ProspectsService } from "./prospects.service";
import { StatementReaderService } from "./statement-reader.service";

@Module({
  imports: [DatabaseModule, MenusModule],
  controllers: [ProspectsController, PublicProspectPreviewController],
  providers: [ProspectsService, StatementReaderService],
})
export class ProspectsModule {}
