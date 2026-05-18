import { IsEnum, IsOptional, IsString } from "class-validator";
import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";

export class UpdateOrderStatusDto {
  @ApiProperty({
    enum: ["ACCEPTED", "PREPARING", "READY", "DISPATCHED", "COMPLETED", "CANCELLED", "REJECTED"],
  })
  @IsEnum(["ACCEPTED", "PREPARING", "READY", "DISPATCHED", "COMPLETED", "CANCELLED", "REJECTED"])
  status!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  note?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  cancelReason?: string;
}
