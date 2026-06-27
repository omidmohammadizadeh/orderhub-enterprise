import { Global, Module } from "@nestjs/common";
import { ExpoPushService } from "./expo-push.service";

// Global so any module (driver-app, dispatch, drivers, chat) can inject
// ExpoPushService without import cycles — it's a stateless fetch wrapper.
@Global()
@Module({
  providers: [ExpoPushService],
  exports: [ExpoPushService],
})
export class ExpoPushModule {}
