// Default managed-MongoDB storage price (Atlas-ish), USD per GB-month. Override
// per deployment with STORAGE_USD_PER_GB_MONTH.
export const DEFAULT_STORAGE_USD_PER_GB_MONTH = 0.25;
const BYTES_PER_GB = 1024 ** 3;

// Estimated monthly storage saving from freeing index bytes — the dollar headline.
export function monthlySavingsUsd(
  freedBytes: number,
  ratePerGbMonth: number = DEFAULT_STORAGE_USD_PER_GB_MONTH,
): number {
  if (freedBytes <= 0 || ratePerGbMonth <= 0) return 0;
  return (freedBytes / BYTES_PER_GB) * ratePerGbMonth;
}
