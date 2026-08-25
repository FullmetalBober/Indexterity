import { Injectable } from "@nestjs/common";

// Default managed-MongoDB storage price (Atlas-ish), USD per GB-month. Override
// per deployment with STORAGE_USD_PER_GB_MONTH.
//
// A module constant and not a class field: a caller reading the default price
// should not need an instance to do it, and nothing about it is a dependency.
export const DEFAULT_STORAGE_USD_PER_GB_MONTH = 0.25;
const BYTES_PER_GB = 1024 ** 3;

// What freed index bytes are worth (#354).
@Injectable()
export class CostUtils {
  // Estimated monthly storage saving from freeing index bytes — the dollar headline.
  monthlySavingsUsd(
    freedBytes: number,
    ratePerGbMonth: number = DEFAULT_STORAGE_USD_PER_GB_MONTH,
  ): number {
    if (freedBytes <= 0 || ratePerGbMonth <= 0) return 0;
    return (freedBytes / BYTES_PER_GB) * ratePerGbMonth;
  }
}
