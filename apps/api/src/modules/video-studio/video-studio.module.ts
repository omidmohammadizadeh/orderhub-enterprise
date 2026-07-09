import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { VideoStudioController } from "./video-studio.controller";
import { VideoStudioService } from "./video-studio.service";
import { VideoStudioCron } from "./video-studio.cron";
import { ReplicateProvider } from "./replicate.provider";
import { SupabaseStorageService } from "../uploads/supabase-storage.service";

// AI Video Studio — paid add-on. PrismaService is global; ScheduleModule
// (crons) and ConfigModule are global too, so we only wire this module's own
// providers. SupabaseStorageService is stateless, re-provided here to re-host
// finished renders.
@Module({
  imports: [ConfigModule],
  controllers: [VideoStudioController],
  providers: [
    VideoStudioService,
    VideoStudioCron,
    ReplicateProvider,
    SupabaseStorageService,
  ],
  exports: [VideoStudioService],
})
export class VideoStudioModule {}
