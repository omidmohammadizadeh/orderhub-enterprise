import { ApiProperty } from "@nestjs/swagger";
import type { UserRole } from "@orderhub/database";

export class AuthTokensDto {
  @ApiProperty()
  accessToken!: string;

  @ApiProperty()
  refreshToken!: string;

  @ApiProperty({ example: 900 })
  expiresIn!: number;
}

export class UserProfileDto {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  email!: string;

  @ApiProperty()
  firstName!: string;

  @ApiProperty()
  lastName!: string;

  @ApiProperty({ nullable: true })
  avatarUrl!: string | null;

  @ApiProperty()
  role!: UserRole;

  @ApiProperty({ type: [String] })
  permissions!: string[];

  @ApiProperty()
  tenantId!: string;

  @ApiProperty()
  tenantName!: string;

  @ApiProperty()
  isVerified!: boolean;

  @ApiProperty({ nullable: true })
  brandId!: string | null;

  @ApiProperty({ nullable: true })
  defaultLocationId!: string | null;
}

export class LoginResponseDto {
  @ApiProperty()
  tokens!: AuthTokensDto;

  @ApiProperty()
  user!: UserProfileDto;
}
