import { IsEmail, IsString, MinLength, MaxLength } from "class-validator";
import { ApiProperty } from "@nestjs/swagger";

export class LoginDto {
  @ApiProperty({ example: "admin@demo.orderhub.io" })
  @IsEmail({}, { message: "Must be a valid email address" })
  email!: string;

  @ApiProperty({ example: "Demo1234!", minLength: 8 })
  @IsString()
  @MinLength(8)
  @MaxLength(128)
  password!: string;
}
