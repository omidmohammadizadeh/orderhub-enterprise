import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { IsOptional, IsString, MinLength } from "class-validator";

export class GoogleNativeAuthDto {
  @ApiProperty({ description: "Google ID token from native sign-in" })
  @IsString()
  @MinLength(20)
  idToken!: string;
}

export class AppleFullNameDto {
  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @IsString()
  givenName?: string | null;

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @IsString()
  familyName?: string | null;
}

export class AppleNativeAuthDto {
  @ApiProperty({ description: "Apple identity token from Sign in with Apple" })
  @IsString()
  @MinLength(20)
  idToken!: string;

  // Apple only returns name + email on the FIRST sign-in for a given Apple ID.
  // Subsequent sign-ins return only the idToken. Mobile passes them through
  // when present so we can hydrate the User record on first login.
  @ApiPropertyOptional({ type: AppleFullNameDto })
  @IsOptional()
  fullName?: AppleFullNameDto;

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @IsString()
  email?: string | null;
}
