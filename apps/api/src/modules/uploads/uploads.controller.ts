import {
  Body,
  Controller,
  Post,
  ServiceUnavailableException,
} from "@nestjs/common";
import { ApiTags, ApiOperation } from "@nestjs/swagger";
import { IsOptional, IsString, MaxLength } from "class-validator";
import { SupabaseStorageService } from "./supabase-storage.service";

class UploadImageDto {
  // A data URL (data:image/...;base64,...) or an existing http(s) URL.
  @IsString()
  @MaxLength(15_000_000)
  dataUrl!: string;

  @IsOptional()
  @IsString()
  folder?: string;
}

// Phase AL — image upload to Supabase Storage. Auth required (global JWT
// guard). Returns the public https URL to persist on the product/modifier row.
@ApiTags("uploads")
@Controller({ path: "uploads", version: "1" })
export class UploadsController {
  constructor(private readonly storage: SupabaseStorageService) {}

  @Post("product-image")
  @ApiOperation({ summary: "Upload a menu/product image, returns its public URL" })
  async uploadProductImage(@Body() dto: UploadImageDto): Promise<{ publicUrl: string }> {
    if (!this.storage.isConfigured()) {
      // The dashboard uploader catches this and falls back to a data URL.
      throw new ServiceUnavailableException("Image storage is not configured yet");
    }
    const publicUrl = await this.storage.uploadDataUrl(dto.dataUrl, dto.folder || "products");
    return { publicUrl };
  }
}
