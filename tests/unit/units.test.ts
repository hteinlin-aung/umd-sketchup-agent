import { describe, expect, it } from "vitest";
import { nearlyEqual, parseLength, toMeters } from "../../src/geometry/units";

// YOUR TASK: remove ".skip" below, then make src/geometry/units.ts pass these.
describe.skip("units (Htain's module)", () => {
  describe("toMeters", () => {
    it("converts every supported unit", () => {
      expect(toMeters(3200, "mm")).toBeCloseTo(3.2, 9);
      expect(toMeters(90, "cm")).toBeCloseTo(0.9, 9);
      expect(toMeters(2.4, "m")).toBe(2.4);
      expect(toMeters(12, "in")).toBeCloseTo(0.3048, 9);
      expect(toMeters(16, "ft")).toBeCloseTo(4.8768, 9);
    });
    it("keeps zero and negative values (a z offset can be negative)", () => {
      expect(toMeters(0, "mm")).toBe(0);
      expect(toMeters(-1010, "mm")).toBeCloseTo(-1.01, 9);
    });
  });

  describe("parseLength", () => {
    it("reads number + unit, with or without a space", () => {
      expect(parseLength("3200 mm")).toBeCloseTo(3.2, 9);
      expect(parseLength("2.4m")).toBeCloseTo(2.4, 9);
      expect(parseLength("90 cm")).toBeCloseTo(0.9, 9);
      expect(parseLength("16 ft")).toBeCloseTo(4.8768, 9);
      expect(parseLength("36 in")).toBeCloseTo(0.9144, 9);
    });
    it("ignores capitals and spaces around the text", () => {
      expect(parseLength("  2.4 M ")).toBeCloseTo(2.4, 9);
      expect(parseLength("1200MM")).toBeCloseTo(1.2, 9);
    });
    it("returns null when there is no unit (a bare number is ambiguous)", () => {
      expect(parseLength("3200")).toBeNull();
    });
    it("returns null for things that are not lengths", () => {
      expect(parseLength("")).toBeNull();
      expect(parseLength("abc")).toBeNull();
      expect(parseLength("3.2 kg")).toBeNull();
      expect(parseLength("mm")).toBeNull();
    });
  });

  describe("nearlyEqual", () => {
    it("treats tiny float errors as equal", () => {
      expect(0.1 + 0.2 === 0.3).toBe(false); // why this function exists
      expect(nearlyEqual(0.1 + 0.2, 0.3)).toBe(true);
    });
    it("uses 1 mm by default", () => {
      expect(nearlyEqual(3.2, 3.2009)).toBe(true);
      expect(nearlyEqual(3.2, 3.202)).toBe(false);
    });
    it("accepts a custom tolerance", () => {
      expect(nearlyEqual(3.2, 3.25, 0.1)).toBe(true);
      expect(nearlyEqual(3.2, 3.25, 0.01)).toBe(false);
    });
  });
});
