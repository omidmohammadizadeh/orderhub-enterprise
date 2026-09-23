import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { VideoStudioController } from "./video-studio.controller";
import { VideoStudioService } from "./video-studio.service";
import { VideoStudioCron } from "./video-studio.cron";
import { ReplicateProvider } from "./replicate.provider";
import { GeminiVideoProvider } from "./gemini-video.provider";
import { SupabaseStorageService } from "../uploads/supabase-storage.service";
import { WalletModule } from "../wallet/wallet.module";

// AI Video Studio — paid add-on. PrismaService is global; ScheduleModule
// (crons) and ConfigModule are global too, so we only wire this module's own
// providers. SupabaseStorageService is stateless, re-provided here to re-host
// finished renders.
@Module({
  // WalletModule: renders are billed to the location's wallet, the same
  // balance SMS and AI voice spend.
  imports: [ConfigModule, WalletModule],
  controllers: [VideoStudioController],
  providers: [
    VideoStudioService,
    VideoStudioCron,
    ReplicateProvider,
    GeminiVideoProvider,
    SupabaseStorageService,
  ],
  exports: [VideoStudioService],
})
export class VideoStudioModule {}
