import { IsEnum, IsOptional, IsString } from "class-validator";
import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { OrderStatusSchema } from "@orderhub/shared";

// ── Allowed transition targets ──────────────────────────────────────────────
// Pulled directly from the shared OrderStatus enum so the DTO can't drift
// from the database schema. PENDING is intentionally NOT included here —
// it's the initial state set by ingestCanonical and is not a valid
// transition target (the per-status whitelist in order-state-machine.ts
// enforces the same rule, but the DTO rejects it earlier for a cleaner
// 400 error message).
//
// Historical bug: this list used to be hardcoded with the seven pre-Phase-AJ
// statuses and never updated when ASSIGNED_DRIVER / ACCEPTED_BY_DRIVER /
// OUT_FOR_DELIVERY / FAILED / PENDING_DISPATCH were added. Every "Out for
// delivery" / "Send to dispatch" / driver-handoff button on the board 400'd
// at this validator before the handler ever ran — a flicker the operator
// surfaced as "I have to click twice".
const ALLOWED_STATUSES = OrderStatusSchema.options.filter(
  (s) => s !== "PENDING",
);

export class UpdateOrderStatusDto {
  @ApiProperty({ enum: ALLOWED_STATUSES })
  @IsEnum(ALLOWED_STATUSES)
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
