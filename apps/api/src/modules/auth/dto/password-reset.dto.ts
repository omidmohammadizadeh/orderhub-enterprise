import { ApiProperty } from "@nestjs/swagger";
import { IsEmail, IsString, MinLength, MaxLength } from "class-validator";

export class ForgotPasswordDto {
  @ApiProperty({ example: "you@restaurant.com" })
  @IsEmail({}, { message: "Enter a valid email address" })
  email!: string;
}

export class ResetPasswordDto {
  @ApiProperty({ description: "The token from the emailed link" })
  @IsString()
  // Bounded so an absurd body can't be pushed through the hash.
  @MaxLength(512)
  token!: string;

  @ApiProperty({ minLength: 8 })
  @IsString()
  @MinLength(8, { message: "Choose a password of at least 8 characters" })
  @MaxLength(128)
  newPassword!: string;
}
