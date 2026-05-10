/**
 * Shared financial formatting utility.
 *
 * Financial amounts arrive from the API as decimal strings (e.g. "1234.50") to
 * preserve full precision without floating-point loss. Use this helper whenever
 * displaying a monetary value — never call Number() or parseFloat() directly on
 * API price/total/walletBalance fields.
 */
export function formatCurrency(value: string | number | null | undefined, symbol = "Rs."): string {
  if (value === null || value === undefined || value === "") return `${symbol} 0`;
  const num = typeof value === "number" ? value : parseFloat(String(value));
  if (isNaN(num)) return `${symbol} 0`;
  return `${symbol} ${Math.round(num).toLocaleString()}`;
}
