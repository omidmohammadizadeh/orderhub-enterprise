// The Console reports in pounds: Eat For Less trades in the UK only.
const GBP = new Intl.NumberFormat("en-GB", { style: "currency", currency: "GBP" });

export function formatGbp(amount: number): string {
  return GBP.format(amount);
}
