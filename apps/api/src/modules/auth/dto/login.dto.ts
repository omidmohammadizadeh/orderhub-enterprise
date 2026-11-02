import { IsEmail, IsString, MinLength, MaxLength, ValidateIf } from "class-validator";
import { isTabletUsername } from "../../../common/access/tablet-login";
import { ApiProperty } from "@nestjs/swagger";

export class LoginDto {
  @ApiProperty({ example: "admin@demo.orderhub.io" })
  // A shop tablet's username (Team → Tablet logins) has no "@"; everything
  // else must still be a real email address.
  @IsString()
  @ValidateIf((o) => typeof o.email !== "string" || !isTabletUsername(o.email))
  @IsEmail({}, { message: "Must be a valid email address" })
  email!: string;

  @ApiProperty({ example: "Demo1234!", minLength: 8 })
  @IsString()
  @MinLength(8)
  @MaxLength(128)
  password!: string;
}
