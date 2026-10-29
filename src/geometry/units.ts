/**
 * YOUR MODULE (Htain): turning lengths people write into metres.
 *
 * Why it exists: inside the app every length is in metres (PLAN.md §4).
 * Instruction files will say things like "3200 mm", "2.4 m", "90 cm", "16 ft".
 * Week 2's instruction reader uses these functions so a size is never misread.
 *
 * The spec is the test file: tests/unit/units.test.ts
 */



export type LengthUnit = "mm" | "cm" | "m" | "in" | "ft";

// How many metres one of each unit is.
const METRES_PER_UNIT: Record<LengthUnit, number> = {
  mm: 0.001,
  cm: 0.01,
  m: 1,
  in: 0.0254,
  ft: 0.3048,
};

export function toMeters(value: number, unit: LengthUnit): number {
  return value * METRES_PER_UNIT[unit];
}

export function parseLength(text: string): number | null {
  const match = text.trim().toLowerCase().match(/^(-?\d+(?:\.\d+)?)\s*(mm|cm|m|in|ft)$/);
  if (!match) return null;
  return toMeters(Number(match[1]), match[2] as LengthUnit);
}

export function nearlyEqual(a: number, b: number, toleranceM = 0.001): boolean {
  return Math.abs(a - b) <= toleranceM;
}

