import {
  BadRequestException,
  Body,
  Controller,
  Post,
  ServiceUnavailableException,
} from "@nestjs/common";
import { ApiTags, ApiOperation } from "@nestjs/swagger";
import { IsOptional, IsString, MaxLength } from "class-validator";
import { SupabaseStorageService } from "./supabase-storage.service";
import { Roles } from "../../common/decorators/roles.decorator";

class UploadContractFileDto {
  @IsString()
  @MaxLength(15_000_000)
  dataUrl!: string;

  @IsOptional()
  @IsString()
  fileName?: string;
}

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

  /**
   * Upload a contract PDF. Separate from the image route because
   * uploadDataUrl rejects anything that isn't an image, and because the
   * folder must not be operator-controlled here.
   *
   * NOTE: the Supabase bucket is public, so the returned URL is readable by
   * anyone who has it. The path carries a random UUID, which makes it
   * unguessable but not private — do not put a signed contract containing
   * personal data through this route until the bucket has signed URLs.
   * A blank template is fine; that is what this is for.
   */
  @Post("contract-file")
  @Roles("PLATFORM_ADMIN")
  @ApiOperation({ summary: "Upload a contract template PDF, returns its URL" })
  async uploadContractFile(
    @Body() dto: UploadContractFileDto,
  ): Promise<{ publicUrl: string }> {
    if (!this.storage.isConfigured()) {
      throw new ServiceUnavailableException(
        "File storage is not configured — set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY",
      );
    }
    const match = /^data:([^;]+);base64,(.+)$/.exec(dto.dataUrl.trim());
    if (!match || match[1] !== "application/pdf") {
      throw new BadRequestException("Only PDF files can be uploaded");
    }
    const buffer = Buffer.from(match[2]!, "base64");
    if (buffer.length > 10_000_000) {
      throw new BadRequestException("PDF is larger than 10MB");
    }
    const publicUrl = await this.storage.uploadBuffer(
      buffer,
      "application/pdf",
      "contracts",
      "pdf",
    );
    return { publicUrl };
  }
}
