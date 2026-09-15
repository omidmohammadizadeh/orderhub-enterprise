import {
  BadRequestException,
  Body,
  Controller,
  Post,
  ServiceUnavailableException,
} from "@nestjs/common";
import { ApiTags, ApiOperation } from "@nestjs/swagger";
import {
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from "class-validator";
import { SupabaseStorageService } from "./supabase-storage.service";
import {
  InlineImageRehostService,
  type RehostSummary,
} from "./inline-image-rehost.service";
import { Roles } from "../../common/decorators/roles.decorator";

class UploadContractFileDto {
  @IsString()
  @MaxLength(15_000_000)
  dataUrl!: string;

  @IsOptional()
  @IsString()
  fileName?: string;
}

class RehostInlineImagesDto {
  /** Absent or false = dry run. Nothing is written unless this is true. */
  @IsOptional()
  @IsBoolean()
  apply?: boolean;

  /** How many images to move in this pass. */
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(200)
  limit?: number;
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
  constructor(
    private readonly storage: SupabaseStorageService,
    private readonly rehost: InlineImageRehostService,
  ) {}

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
  /**
   * Move images still stored as base64 in Postgres into storage.
   *
   * Exists as an endpoint, not just a CLI script, because running the script
   * means holding the Supabase service_role key — the one credential that
   * bypasses every row-level rule in the project — in a terminal. The API
   * already has it, so nobody else needs to.
   *
   * Dry run unless `apply` is true, and bounded per call: it reports what is
   * still waiting so the caller can run it again rather than hold an HTTP
   * request open through hundreds of uploads.
   */
  @Post("rehost-inline-images")
  @Roles("PLATFORM_ADMIN")
  @ApiOperation({ summary: "Move base64 images out of the database into storage" })
  async rehostInlineImages(
    @Body() dto: RehostInlineImagesDto,
  ): Promise<RehostSummary> {
    return this.rehost.run({ apply: dto.apply === true, limit: dto.limit });
  }

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
