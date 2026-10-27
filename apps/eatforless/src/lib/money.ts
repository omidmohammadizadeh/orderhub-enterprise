import type { Money } from "@/api/types";

export function toNumber(v: Money | null | undefined): number {
  if (v == null) return 0;
  const n = typeof v === "number" ? v : parseFloat(v);
  return Number.isFinite(n) ? n : 0;
}

export const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

/** £12.50 — pilot is UK-only, so GBP. */
export function money(v: Money | null | undefined): string {
  return `£${toNumber(v).toFixed(2)}`;
}
