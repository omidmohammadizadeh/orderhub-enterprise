import { Global, Module } from "@nestjs/common";
import { PrismaService } from "./prisma.service";

// @Global makes PrismaService available throughout the app without re-importing
@Global()
@Module({
  providers: [PrismaService],
  exports: [PrismaService],
})
export class DatabaseModule {}
