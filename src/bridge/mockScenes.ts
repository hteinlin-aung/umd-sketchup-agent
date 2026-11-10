import type { Bounds } from "../protocol/tools";
import type { MockEntity, MockSketchUp } from "./mockSketchUp";

/**
 * A simplified copy of the room in UMD_DEV_1F_reception.skp, so the summary and the
 * planner can be tested on the Mac. Names, tags and rough sizes come from the real
 * Outliner (AGENT_HANDOFF/OUTLINER_TREE.txt); the positions are made up but sensible:
 * the main entrance is a gap in the middle of the east glass wall (+x = east).
 *
 * It includes the real trap: "Sofa set 4" holds only a palm.
 */
const FLOOR = 1.489;

const box = (x0: number, y0: number, x1: number, y1: number, h: number, z0 = FLOOR): Bounds => ({
  min: [x0, y0, z0],
  max: [x1, y1, z0 + h],
});

export function seedReceptionScene(m: MockSketchUp): void {
  const TERR = "1F Reception - Terrariums (T128)";
  const FURN = "1F Reception - Furniture (T128)";
  const LIGHT = "1F Reception - Lighting (T128)";
  const GLASS = "1F Reception - Glazing (T132)";
  for (const t of [TERR, FURN, LIGHT, GLASS, "Plants"]) m.tags.set(t, true);
  m.materials.add("Travertine");

  const group = (name: string, parent: MockEntity | null, bounds: Bounds, tag = "Layer0") =>
    m.addEntity({ type: "Group", name, tag, parentId: parent ? parent.entityId : null, bounds });
  const component = (definitionName: string, parent: MockEntity, bounds: Bounds, tag = "Layer0", name = "") =>
    m.addEntity({ type: "ComponentInstance", name, definitionName, tag, parentId: parent.entityId, bounds });

  const room = group("1F RECEPTION - TERRARIUMS + LOUNGE (T128, per revised plan)", null, box(10, 0, 41.479, 25.86, 3.501));

  const terrA = group("Terrarium A - behind reception, blackened steel frame + glass (wraps 2 columns)", room, box(24, 9.5, 25.6, 16.4, 2.8), TERR);
  group("base frame / kick 300", terrA, box(24.2, 9.65, 25.4, 16.25, 0.3));
  group("soil + moss bed", terrA, box(24.25, 9.7, 25.35, 16.2, 0.2, FLOOR + 0.3));
  group("glass W", terrA, box(24.2, 9.65, 24.21, 16.25, 2.5, FLOOR + 0.3));
  group("glass E", terrA, box(25.39, 9.65, 25.4, 16.25, 2.5, FLOOR + 0.3));
  for (const y of [9.65, 12.95, 16.21]) group("steel post 40", terrA, box(24.2, y, 24.24, y + 0.04, 2.8));
  const plantA = group("Terrarium A planting (3DW ferns, palms, rocks)", terrA, box(24, 9.5, 25.6, 16.4, 1.3, FLOOR + 0.5), TERR);
  component("3DW Boston fern", plantA, box(24.3, 10, 24.9, 10.6, 0.6, FLOOR + 0.5), "Plants");
  component("3DW Lady palm (Rhapis excelsa)", plantA, box(24.4, 12.5, 25.2, 13.3, 1.2, FLOOR + 0.5), "Plants");

  const terrE = group("Terrarium E - big living forest (west strip, per plan) - steel frame, floor-to-ceiling glass", room, box(11, 6, 14.6, 18.3, 3.5), TERR);
  group("travertine base 450", terrE, box(11.9, 6.7, 13.6, 17.6, 0.45));
  group("glass E", terrE, box(13.59, 6.7, 13.6, 17.6, 3.0, FLOOR + 0.45));
  const plantE = group("Terrarium E planting - layered forest (areca, lady palm, parlor palm, ferns, rocks)", terrE, box(11, 6, 14.6, 18.3, 2.2, FLOOR + 0.45), TERR);
  component("3DW Areca palm", plantE, box(12, 8, 13, 9, 2.0, FLOOR + 0.45), "Plants");

  const sofa4 = group("Sofa set 4 - reception lounge (copy of set 2, rotated 180, per revised plan)", room, box(30, 20, 31, 21, 0.8));
  component("3DW Chamaedorea elegans - parlor palm (Botanist traveler)", sofa4, box(30, 20, 31, 20.9, 0.9), "Plants");

  const lounge = group("Lounge bay restyle (T130) - curved boucle sofa, olive armchairs, travertine + wood round tables, round rugs", room, box(16, 19, 29.2, 25.2, 0.7), FURN);
  const sofa1 = component("3DW Mercy S. curved sofa", lounge, box(17, 20, 18.7, 23, 0.6), "Layer0", "Sofa set 1 - curved boucle sofa (3DW Mercy S.)");
  group("", sofa1, box(17, 20, 18.7, 23, 0.4));
  component("Round table travertine", lounge, box(19.2, 21.2, 19.9, 21.9, 0.7), "Layer0", "Sofa set 1 - round coffee table, travertine");
  group("Sofa set 1 - round rug 3.2 m", lounge, box(17.4, 19.9, 20.6, 23.1, 0.01));

  const glass = group("EAST GLASS WALL (T132) - floor-to-ceiling low-iron glass, bronze frames, either side of main entrance", room, box(41.379, 8.1, 41.479, 17.7, 3.5), GLASS);
  group("glass panel south of entrance", glass, box(41.379, 8.1, 41.479, 11.7, 3.5));
  group("glass panel north of entrance", glass, box(41.379, 14.1, 41.479, 17.7, 3.5));
  group("bronze head frame over entrance", glass, box(41.379, 11.7, 41.479, 14.1, 0.3, FLOOR + 3.2));

  const lights = group("CEILING LIGHTS - reception, low-glare 3000K downlights (LT01) - set emissive in D5", room, box(12, 1, 39.6, 25.1, 0.3, 4.689), LIGHT);
  for (const x of [15, 25, 35]) group("downlight", lights, box(x, 12, x + 0.1, 12.1, 0.3, 4.689), LIGHT);
}
