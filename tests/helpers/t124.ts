import type { Bounds } from "../../src/protocol/tools";
import type { RoomSummary, SummaryItem } from "../../src/summary/roomSummary";
import { findSubRooms, type Part, type TradeItem } from "../../src/summary/subRooms";

/**
 * A cut-down copy of the real T124 group from Windows (2026-11-14, dev/UMD_DEV_3F.skp): organised by TRADE, so each
 * item holds parts of every room and "Therapy 1" exists only at the start of part names. Real names and boxes.
 */
let pid = 1000;
const part = (name: string, min: Bounds["min"], max: Bounds["max"]): Part => ({ name, definitionName: "", bounds: { min, max }, persistentId: pid++, hidden: false });

export function t124Trade(): TradeItem[] {
  return [
    { ref: "R1", name: "DOORS - solid oak acoustic, seals, CAD positions", parts: [
      part("Therapy 1 door 900", [18.775, 76.88, 10.98], [18.925, 77.78, 13.38]),
      part("Therapy 2 door 900", [18.775, 83.56, 10.98], [18.925, 84.46, 13.38]),
      part("Group therapy door 1200 (double)", [19.66, 72.315, 10.98], [20.86, 72.465, 13.38]),
    ] },
    { ref: "R2", name: "FLOOR finishes (3 mm, floor level unchanged)", parts: [
      part("Therapy 1 - M09 acoustic carpet greige", [8.72, 76.06, 10.98], [18.8, 80.46, 10.983]),
      part("Therapy 2 - M09 acoustic carpet greige", [8.72, 80.56, 10.98], [18.8, 84.98, 10.983]),
      part("Group therapy - M08 warm-grey resilient", [8.72, 64.75, 10.98], [21.8, 75.96, 10.983]),
    ] },
    { ref: "R3", name: "WALL finishes - M11 matte off-white plaster", parts: [
      part("M11 plaster lining 10 mm", [8.75, 64.78, 10.983], [8.76, 89.48, 13.78]),
    ] },
    { ref: "R4", name: "OAK wall panels - M02 vertical boards", parts: [
      part("Therapy 1 feature wall (north) - M02 oak board 1/10 (300, 6 mm shadow joint)", [9.65, 80.43, 11.08], [9.95, 80.45, 13.77]),
      part("Therapy 1 feature wall (north) - M02 oak board 2/10 (300, 6 mm shadow joint)", [9.95, 80.43, 11.08], [10.25, 80.45, 13.77]),
      part("Therapy 1 feature wall (north) - recessed shadow plinth 100", [9.65, 80.44, 10.98], [12.65, 80.45, 11.08]),
    ] },
    { ref: "R5", name: "ACOUSTIC panels - greige fabric, 40 mm mineral-wool core", parts: [
      part("Therapy 1 feature wall (north) - acoustic panel 1100 x 1650", [12.73, 80.41, 11.88], [13.83, 80.45, 13.53]),
      part("Therapy 1 south wall - acoustic panel 1200 x 1400", [10, 76.07, 11.88], [11.2, 76.11, 13.28]),
      part("Therapy 1 south wall - acoustic panel 1200 x 1400", [11.35, 76.07, 11.88], [12.55, 76.11, 13.28]),
    ] },
    { ref: "R6", name: "CEILINGS + LIGHTING", parts: [
      part("Therapy 1 ceiling", [8.72, 76.06, 13.78], [18.8, 80.46, 13.9]),
      part("Therapy 2 ceiling", [8.72, 80.56, 13.78], [18.8, 84.98, 13.9]),
    ] },
    { ref: "R8", name: "FURNITURE - CAD positions + orientations (3D Warehouse + joinery)", parts: [
      part("Therapy 1 - armchair (3DW Moroso Gogan, boucle) on CAD U armchair", [11.565, 79.23, 10.98], [12.84, 80.52, 11.65]),
      part("Therapy 1 - armchair (3DW Moroso Gogan, boucle) on CAD U armchair", [11.69, 77.41, 10.98], [12.946, 78.65, 11.65]),
      part("Therapy 1 - desk (oak top, walnut legs) on CAD desk", [15.98, 78.368, 10.983], [16.961, 80.325, 11.728]),
      part("Therapy 2 - desk (oak top, walnut legs) on CAD desk", [15.98, 81.08, 10.983], [16.96, 83.03, 11.73]),
      part("Group therapy - workshop table 4.6 x 1.26 (oak top, walnut legs) on CAD table", [11.532, 66.982, 10.983], [16.111, 68.244, 11.723]),
    ] },
  ];
}

/** The T124 summary as summarizeRoom builds it, with the sub-rooms. */
export function t124(): RoomSummary {
  const trade = t124Trade();
  const items: SummaryItem[] = trade.map((t, i) => {
    const b = { min: [0, 1, 2].map((k) => Math.min(...t.parts.map((p) => p.bounds.min[k]!))), max: [0, 1, 2].map((k) => Math.max(...t.parts.map((p) => p.bounds.max[k]!))) } as Bounds;
    return {
      ref: t.ref, name: t.name, type: "Group", tag: `3F TP - ${i}`, visible: true, entityId: i + 1, persistentId: i + 1, path: [], bounds: b,
      size: [0, 1, 2].map((k) => b.max[k]! - b.min[k]!) as [number, number, number], contents: [], childCount: t.parts.length, categories: [], warnings: [], canChange: true,
    };
  });
  const subRooms = findSubRooms(trade, { floorZ: 10.979, top: 13.9 }, 12);
  return {
    room: { name: "3F THERAPY + PSYCHIATRIST INTERIOR (T124) - Calm Biophilic Luxury", entityId: 99, persistentId: 99, path: [], bounds: { min: [8.72, 64.75, 10.98], max: [37.63, 89.481, 13.9] }, size: [28.91, 24.731, 2.92] },
    floor: { z: 10.979, source: "3F finish floor (confirmed levels)" },
    modelPath: "E:/Cowork_Field/Thesis_SketchUp/dev/UMD_DEV_3F.skp",
    items,
    tags: [],
    materials: { design: [], otherCount: 0 },
    notes: [],
    subRooms,
  };
}
