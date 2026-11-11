import type { Bounds } from "../protocol/tools";
import type { MockEntity, MockSketchUp } from "./mockSketchUp";

/**
 * A copy of the room in UMD_DEV_1F_reception.skp for the fake SketchUp, so the summary and
 * the planner can be tested on the Mac with the REAL positions.
 *
 * The 12 items, their order, names, tags and boxes come from `npm run summary` on Windows
 * (2026-11-11, identical on the dev copy and the MASTER). Their insides are simplified:
 * a few named parts each, enough for the "what does it really contain" check.
 * It keeps the real trap: "Sofa set 4" holds only a palm.
 */
const FLOOR = 1.489;
const TOP = 4.99;

const b = (x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): Bounds => ({
  min: [x0, y0, z0],
  max: [x1, y1, z1],
});

export function seedReceptionScene(m: MockSketchUp): void {
  const TERR = "1F Reception - Terrariums (T128)";
  const FURN = "1F Reception - Furniture (T128)";
  const LIGHT = "1F Reception - Lighting (T128)";
  const WALL = "1F Reception - Feature wall (T130)";
  const GLASS = "1F Reception - Glazing (T132)";
  for (const t of [TERR, FURN, LIGHT, WALL, GLASS, "Plants"]) m.tags.set(t, true);
  m.materials.add("Material82");

  const group = (name: string, parent: MockEntity | null, bounds: Bounds, tag = "Layer0") =>
    m.addEntity({ type: "Group", name, tag, parentId: parent ? parent.entityId : null, bounds });
  const component = (definitionName: string, parent: MockEntity, bounds: Bounds, tag = "Layer0", name = "") =>
    m.addEntity({ type: "ComponentInstance", name, definitionName, tag, parentId: parent.entityId, bounds });
  /** Named parts inside an item, all given the item's own box (only the names matter here). */
  const parts = (parent: MockEntity, names: string[]) => {
    for (const n of names) group(n, parent, parent.bounds);
  };

  const room = group("1F RECEPTION - TERRARIUMS + LOUNGE (T128, per revised plan)", null, b(70.94, 84.4, FLOOR, 102.419, 110.26, TOP));

  const a = group("Terrarium A - behind reception, blackened steel frame + glass (wraps 2 columns)", room, b(88.362, 98.833, FLOOR, 89.956, 105.707, 4.329), TERR);
  parts(a, ["base frame / kick 300", "soil + moss bed", "glass W", "glass E", "glass S", "glass N", "glass lid"]);
  for (let i = 0; i < 10; i++) group("steel post 40", a, a.bounds);
  const plantA = group("Terrarium A planting (3DW ferns, palms, rocks)", a, a.bounds, TERR);
  component("3DW Boston fern", plantA, plantA.bounds, "Plants");

  for (const [name, x0, x1] of [
    ["Terrarium B1 - lounge divider, curved glass corners, travertine base (wraps column)", 78.755, 80.313],
    ["Terrarium B2 - lounge divider, curved glass corners, travertine base (wraps column)", 83.662, 85.256],
  ] as const) {
    const t = group(name, room, b(x0, 86.7, FLOOR, x1, 92.343, 4.289), TERR);
    parts(t, ["travertine planter base 350", "soil + moss", "curved-corner glass 12 mm", "top channel - bronze"]);
  }

  const c = group("Terrarium C - exhibition glass column, travertine base, bronze mullions, oak ceiling halo", room, b(89.24, 92.44, FLOOR, 94.12, 97.32, TOP), TERR);
  parts(c, ["travertine base r1.55", "cylindrical glass r1.40", "oak ceiling halo r2.40 (canopy)"]);

  const sofa4 = group("Sofa set 4 - reception lounge (copy of set 2, rotated 180, per revised plan)", room, b(84.502, 103.492, 1.501, 85.454, 104.449, 2.352));
  component("3DW Chamaedorea elegans - parlor palm (Botanist traveler)", sofa4, sofa4.bounds, "Plants");

  const lights = group("CEILING LIGHTS - reception, low-glare 3000K downlights (LT01) - set emissive in D5", room, b(70.94, 85.14, 4.686, 98.56, 110.26, 4.987), LIGHT);
  for (const x of [75, 85, 95]) group("downlight", lights, b(x, 100, 4.686, x + 0.1, 100.1, 4.987), LIGHT);

  const d = group("Corner lounge D (T129) - planted rock wall, oak slat ceiling, curved sofa (per inspiration)", room, b(94.642, 90.729, FLOOR, 102.419, 98.805, TOP), TERR);
  parts(d, ["planter kerb + bed - travertine 250", "Planted rock wall (3DW rocks, palms, ferns)"]);
  group("Curved sofa lounge - boucle sofa, travertine + walnut tables", d, d.bounds, FURN);

  const e = group("Terrarium E - big living forest (west strip, per plan) - steel frame, floor-to-ceiling glass", room, b(76.844, 97.233, FLOOR, 80.457, 109.495, TOP), TERR);
  parts(e, ["travertine base 450", "soil + moss bed", "glass W", "glass E"]);
  const plantE = group("Terrarium E planting - layered forest (areca, lady palm, parlor palm, ferns, rocks)", e, e.bounds, TERR);
  component("3DW Areca palm", plantE, plantE.bounds, "Plants");

  const f = group("Feature wall F - oak slats, backlit preserved-moss panels, travertine bench + plants (bays east wall)", room, b(92.343, 84.4, FLOOR, 94.621, 92.009, TOP), WALL);
  parts(f, ["dark walnut backing behind slats", "preserved moss + fern panel 1 (art)", "travertine bench"]);

  const lounge = group("Lounge bay restyle (T130) - curved boucle sofa, olive armchairs, travertine + wood round tables, round rugs", room, b(75.43, 87.717, FLOOR, 88.612, 103.904, 2.175), FURN);
  const sofa1 = component("3DW Mercy S. curved sofa", lounge, b(76, 95, FLOOR, 77.7, 98, 2.089), "Layer0", "Sofa set 1 - curved boucle sofa (3DW Mercy S.)");
  group("", sofa1, sofa1.bounds);
  component("Round table travertine", lounge, b(78, 96, FLOOR, 78.7, 96.7, 2.175), "Layer0", "Sofa set 1 - round coffee table, travertine");
  group("Sofa set 1 - round rug 3.2 m", lounge, b(75.6, 94.9, FLOOR, 78.8, 98.1, 1.499));

  const ne = group("NE relaxation lounge (T131) - restyle + oak/moss feature wall + planting", room, b(96.44, 104.262, FLOOR, 102.298, 109.079, TOP), FURN);
  component("3DW Mercy S. curved sofa", ne, b(97, 105, FLOOR, 98.7, 108, 2.089), "Layer0", "curved boucle sofa (3DW Mercy S.)");
  group("round rug 3.2 m", ne, b(96.2, 105, FLOOR, 99.4, 108.2, FLOOR + 0.01));
  group("walnut backing", ne, b(102.2, 104.5, FLOOR, 102.298, 108.8, 4.5));

  // The main entrance is the gap between the two glass panels (assumed in the middle).
  const glass = group("EAST GLASS WALL (T132) - floor-to-ceiling low-iron glass, bronze frames, either side of main entrance", room, b(101.232, 98.45, FLOOR, 101.332, 108.1, 4.98), GLASS);
  group("glass 12 mm low-iron", glass, b(101.232, 98.45, FLOOR, 101.332, 102.075, 4.98));
  group("glass 12 mm low-iron", glass, b(101.232, 104.475, FLOOR, 101.332, 108.1, 4.98));
}
