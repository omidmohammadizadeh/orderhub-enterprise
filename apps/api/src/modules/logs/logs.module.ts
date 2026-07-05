// Phase LG — operator-facing activity feed.
//
// @Global() so any service can inject ActivityLogService (marked @Optional()
// at the injection sites) without every module importing LogsModule. The
// "activity.log" event path exists too for services that already carry an
// EventEmitter2.

import { Global, Module } from "@nestjs/common";
import { ActivityLogService } from "./activity-log.service";
import { LogsController } from "./logs.controller";

@Global()
@Module({
  controllers: [LogsController],
  providers: [ActivityLogService],
  exports: [ActivityLogService],
})
export class LogsModule {}
