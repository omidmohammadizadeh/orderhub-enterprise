import { Module } from "@nestjs/common";
import { UploadsController } from "./uploads.controller";
import { SupabaseStorageService } from "./supabase-storage.service";

// Phase AL — image uploads to Supabase Storage.
@Module({
  controllers: [UploadsController],
  providers: [SupabaseStorageService],
  exports: [SupabaseStorageService],
})
export class UploadsModule {}
