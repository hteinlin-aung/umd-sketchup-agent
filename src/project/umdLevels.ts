/**
 * Urban Mind Detox: confirmed levels, world Z in metres.
 *
 * Measured on the MASTER with `npm run levels` (Windows report, 2026-11-02): rays straight
 * down through UMD 2F and UMD 3F agreed on every shared level, and match the original
 * handoff README. These replace the old values in umd_export_rooms.rb (0.289 / 4.761 / 8.761),
 * which were NOT floor levels.
 *
 * finishFloor is the one to build on (top of the "floor plate (finish surface)").
 * Ceilings vary by room; the values below are the ones measured at the probe points only.
 */
export const UMD_LEVELS = {
  "1F": { finishFloor: 1.489, sampleCeiling: 4.689 }, // 3.20 m clear at the lobby/gallery probe
  "2F": { finishFloor: 5.479, structuralSlabTop: 5.204, sampleCeiling: 8.979 }, // 3.50 m clear
  "3F": { finishFloor: 10.979, structuralSlabTop: 10.729, sampleCeiling: 13.779 }, // 2.80 m (corridor)
  roof: { finishFloor: 15.979, structuralSlabTop: 15.729 },
} as const;

export const UMD_SITE = {
  waterUnderBuilding: 0.189,
  lakeBed: -1.011,
} as const;

export type UmdFloor = "1F" | "2F" | "3F";

/** Finish-floor height of a storey, e.g. finishFloor("1F") -> 1.489 */
export function finishFloor(floor: UmdFloor): number {
  return UMD_LEVELS[floor].finishFloor;
}
