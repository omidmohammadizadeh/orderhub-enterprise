import { IsEmail, IsString, MinLength, IsOptional, IsBoolean } from "class-validator";

export class CustomerSignupDto {
  @IsEmail()
  email!: string;

  // 8+ chars, mirrors PasswordService.validateStrength minimum. Stricter
  // strength rules (uppercase, number) are applied in the service so we
  // can return the user-friendly multi-rule error message rather than
  // a generic DTO validation 400.
  @IsString()
  @MinLength(8)
  password!: string;

  @IsString()
  @MinLength(1)
  firstName!: string;

  @IsString()
  @MinLength(1)
  lastName!: string;

  @IsString()
  @IsOptional()
  phone?: string;

  @IsBoolean()
  @IsOptional()
  marketingOptIn?: boolean;

  // Slug of the storefront the customer signed up from — used to build
  // the email-confirmation deep link. The verify endpoint can fall
  // back to a default if absent.
  @IsString()
  @IsOptional()
  storeSlug?: string;
}
