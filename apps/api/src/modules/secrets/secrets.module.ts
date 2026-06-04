import { Module } from "@nestjs/common";
import { SecretsService } from "./secrets.service";
import { SecretsController } from "./secrets.controller";
import { AuthModule } from "../auth/auth.module";

@Module({
  imports: [AuthModule],
  controllers: [SecretsController],
  providers: [SecretsService],
  exports: [SecretsService],
})
export class SecretsModule {}
