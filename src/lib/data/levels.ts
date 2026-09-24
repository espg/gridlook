import type { TSourceLevel, TSources } from "@/lib/types/GlobeTypes.ts";

/**
 * The level every consumer of a dataset reads: `levels[selectedLevel]`, or
 * the first level while nothing has been selected (single-level datasets
 * never select anything, so they keep reading `levels[0]`).
 */
export function currentLevel(datasources: TSources): TSourceLevel {
  return datasources.levels[datasources.selectedLevel ?? 0];
}
