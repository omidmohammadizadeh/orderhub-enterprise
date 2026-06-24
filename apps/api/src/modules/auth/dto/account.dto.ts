import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import {
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from "class-validator";

export class ChangePasswordDto {
  // Optional: OAuth-only accounts have no existing password to verify, so
  // they're setting one for the first time.
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  currentPassword?: string;

  @ApiProperty({ minLength: 8 })
  @IsString()
  @MinLength(8, { message: "New password must be at least 8 characters" })
  @MaxLength(128)
  newPassword!: string;
}

export class UpdateProfileDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(80)
  firstName?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(80)
  lastName?: string;

  // Profile image as a data URI (or hosted URL). Empty string clears it.
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(5_000_000)
  avatarUrl?: string;
}

export class DeleteAccountDto {
  // Must equal the exact phrase "DELETE MY ACCOUNT" — a typed confirmation
  // that the user really intends to permanently erase their account.
  @ApiProperty({ example: "DELETE MY ACCOUNT" })
  @IsString()
  confirm!: string;
}
