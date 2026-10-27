// The Console reports in pounds: Eat For Less trades in the UK only.
const GBP = new Intl.NumberFormat("en-GB", { style: "currency", currency: "GBP" });

export function formatGbp(amount: number): string {
  return GBP.format(amount);
}

/** The API's own words for a failed request, or `fallback` when it sent none. */
export function apiErrorMessage(err: unknown, fallback: string): string {
  const message = (err as { response?: { data?: { message?: unknown } } })?.response?.data?.message;
  if (Array.isArray(message)) return message.join(". ") || fallback;
  if (typeof message === "string" && message.trim()) return message;
  return fallback;
}
