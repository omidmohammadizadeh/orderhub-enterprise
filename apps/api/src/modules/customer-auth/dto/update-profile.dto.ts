import { IsOptional, IsString, Matches, MaxLength, MinLength } from "class-validator";

/**
 * What a signed-in customer can change about themselves from "My account"
 * or by ticking "save my details" at checkout.
 *
 * Every field is optional — send only what changed. `null` clears an
 * optional field (phone, address parts, date of birth); names can be
 * changed but never emptied.
 */
export class UpdateCustomerProfileDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(80)
  firstName?: string;

  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(80)
  lastName?: string;

  @IsOptional()
  @IsString()
  @MaxLength(32)
  phone?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(160)
  addressLine1?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(160)
  addressLine2?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  addressCity?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(16)
  addressPostcode?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  addressArea?: string | null;

  /** YYYY-MM-DD. The calendar and age checks live in the service. */
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: "Date of birth must be YYYY-MM-DD" })
  dateOfBirth?: string | null;
}
