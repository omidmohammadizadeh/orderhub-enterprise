import { Module } from "@nestjs/common";
import { SignageController } from "./signage.controller";
import { SignageService } from "./signage.service";
import { MenusModule } from "../menus/menus.module";

// MenusModule exports MenusService, whose findActiveMenuForLocation the public
// render endpoint reuses so signage boards mirror the POS menu exactly.
@Module({
  imports: [MenusModule],
  controllers: [SignageController],
  providers: [SignageService],
})
export class SignageModule {}
