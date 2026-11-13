import type { Bounds } from "../../src/protocol/tools";
import type { RoomSummary, SummaryItem } from "../../src/summary/roomSummary";

/**
 * The real T133 room summary from Windows (2026-11-13): one room group holding two raised rooms - the breathing
 * room in the west, the meditation room in the east - with an open courtyard void between them.
 */
export function t133(): { summary: RoomSummary; refs: Map<string, SummaryItem> } {
  const item = (ref: string, name: string, min: Bounds["min"], max: Bounds["max"], contents: string[]): SummaryItem => ({
    ref, name, type: "Group", tag: name, visible: true, entityId: 1, persistentId: 1, path: [], bounds: { min, max },
    size: [max[0] - min[0], max[1] - min[1], max[2] - min[2]], contents, childCount: contents.length, categories: ["glass"], warnings: [], canChange: true,
  });
  const items = [
    item("R1", "MEDITATION ROOM (T133) - stillness, zen focal point", [44.305, 69.43, 2.09], [64.655, 79.815, 5.085], ["Floor - M07 tatami", "Ceiling - M02 oak slats", "4× paper floor lantern"]),
    item("R2", "BREATHING ROOM (T133) - floor-based breathing zone", [15, 69.15, 2.02], [34.6, 79.335, 4.99], ["Floor - M07 tatami", "Ceiling - suspended FR fabric sails"]),
  ];
  const summary: RoomSummary = {
    room: { name: "1F MEDITATION + BREATHING ROOMS (T133)", entityId: 1, persistentId: 1, path: [], bounds: { min: [15, 69.15, 2.02], max: [64.655, 79.815, 5.085] }, size: [49.655, 10.665, 3.065] },
    floor: { z: 1.489, source: "1F finish floor (confirmed levels)" },
    modelPath: "E:/dev/UMD_DEV_1F_meditation.skp",
    items,
    tags: [],
    materials: { design: [], otherCount: 0 },
    notes: [],
  };
  return { summary, refs: new Map(items.map((it) => [it.ref, it])) };
}
