import { BadRequestException } from "@nestjs/common";
import type { Prisma } from "@orderhub/database";
import {
  DELIVEROO_MODIFIER_TYPE_KEY,
  DELIVEROO_MODIFIER_TYPES,
  isDeliverooGroupModifierType,
} from "@orderhub/shared";

/**
 * A group's metadata with its Deliveroo modifier type set, or cleared when
 * blank. Every other key is kept. An unknown value is refused rather than
 * stored: the uploader would silently drop it, and the operator would think
 * Deliveroo had been told something it never was.
 */
export function withDeliverooModifierType(
  metadata: unknown,
  type: string | null | undefined,
): Prisma.InputJsonValue {
  const next: Record<string, unknown> =
    metadata && typeof metadata === "object" && !Array.isArray(metadata)
      ? { ...(metadata as Record<string, unknown>) }
      : {};
  if (type == null || type === "") {
    delete next[DELIVEROO_MODIFIER_TYPE_KEY];
  } else if (isDeliverooGroupModifierType(type)) {
    next[DELIVEROO_MODIFIER_TYPE_KEY] = type;
  } else {
    throw new BadRequestException(
      `"${type}" isn't a Deliveroo modifier type. Use one of: ${DELIVEROO_MODIFIER_TYPES.map((t) => t.value).join(", ")}.`,
    );
  }
  return next as Prisma.InputJsonValue;
}
