import { Module } from "@nestjs/common";
import { UploadsController } from "./uploads.controller";
import { SupabaseStorageService } from "./supabase-storage.service";
import { InlineImageRehostService } from "./inline-image-rehost.service";

// Phase AL — image uploads to Supabase Storage.
@Module({
  controllers: [UploadsController],
  providers: [SupabaseStorageService, InlineImageRehostService],
  exports: [SupabaseStorageService, InlineImageRehostService],
})
export class UploadsModule {}
