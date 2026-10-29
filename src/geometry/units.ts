/**
 * YOUR MODULE (Htain): turning lengths people write into metres.
 *
 * Why it exists: inside the app every length is in metres (PLAN.md §4).
 * Instruction files will say things like "3200 mm", "2.4 m", "90 cm", "16 ft".
 * Week 2's instruction reader uses these functions so a size is never misread.
 *
 * The spec is the test file: tests/unit/units.test.ts
 * 1. Remove `.skip` from the `describe.skip(...)` line in that file.
 * 2. Run `npm test` and watch them fail.
 * 3. Write the three functions below until every test passes.
 */

export type LengthUnit = "mm" | "cm" | "m" | "in" | "ft";

/** 3200, "mm" -> 3.2 */
export function toMeters(value: number, unit: LengthUnit): number {
  throw new Error(`TODO(Htain): toMeters(${value}, ${unit})`);
}

/**
 * Reads a written length and returns metres, or null if it cannot be read.
 * "3200 mm" -> 3.2 · "2.4m" -> 2.4 · "90 cm" -> 0.9 · "16 ft" -> 4.8768 · "abc" -> null
 */
export function parseLength(text: string): number | null {
  throw new Error(`TODO(Htain): parseLength(${JSON.stringify(text)})`);
}

/** Compares lengths with a tolerance; never use === on measured numbers. */
export function nearlyEqual(a: number, b: number, toleranceM = 0.001): boolean {
  throw new Error(`TODO(Htain): nearlyEqual(${a}, ${b}, ${toleranceM})`);
}
