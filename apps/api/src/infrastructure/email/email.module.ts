// Phase AP-AUTH — Global email module.
//
// Marked @Global so feature modules can inject EmailService without
// re-importing EmailModule each time. Same pattern as PrismaModule /
// SocketModule.

import { Global, Module } from "@nestjs/common";
import { EmailService } from "./email.service";

@Global()
@Module({
  providers: [EmailService],
  exports: [EmailService],
})
export class EmailModule {}
