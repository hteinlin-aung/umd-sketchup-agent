import type { Plan } from "../agent/resolve";
import { describeView, type ViewOption } from "../agent/views";
import type { BridgeClient } from "../bridge/client";
import type { RoomSummary } from "../summary/roomSummary";

/**
 * Week 3: before the plan is shown, every screenshot standpoint is checked against the REAL model with two
 * `measure` rays (visible geometry only), in the order the resolver ranked them:
 *   1. straight down from the eye: the first surface must be the floor the new pieces stand on - not a raised
 *      platform, not a table, not a void;
 *   2. from the eye's spot, at the pieces' own height, toward them: nothing may be hit before their near face.
 * The first standpoint that passes is used. Boxes in the room summary can't see a hallway wall or a glass
 * screen in another group (Windows, 2026-11-13, brief 5); rays can.
 */

const FLOOR_TOLERANCE = 0.15;
const r3 = (v: number) => Math.round(v * 1000) / 1000;
const label = (path: string[]) => [...path].reverse().find((n) => n && !/^(group|component)#\d+$/i.test(n)) ?? path.at(-1) ?? "something";

/** Why this standpoint is no good in the real model, or null if it is. `floorKnown` false: the model has no floor. */
export async function viewProblem(client: BridgeClient, o: ViewOption, floorKnown = true): Promise<string | null> {
  if (floorKnown) {
    const down = await client.call("measure", { from: o.eye, direction: "down", maxDistance: 5 });
    if (!down.ok) throw new Error(`view check failed: ${down.error.code}: ${down.error.message}`);
    const floor = down.data.hits[0];
    if (!floor) return "no floor under it";
    if (Math.abs(floor.point[2] - o.floorZ) > FLOOR_TOLERANCE) return `it would stand on "${label(floor.path)}" at z ${r3(floor.point[2])}, not on the floor`;
  }
  if (o.near <= 0) return null; // a view of the whole room: nothing particular to see past
  const sight = await client.call("measure", { from: [o.eye[0], o.eye[1], o.rayZ], direction: o.look, maxDistance: o.near });
  if (!sight.ok) throw new Error(`view check failed: ${sight.error.code}: ${sight.error.message}`);
  const hit = sight.data.hits[0];
  if (hit && hit.distance < o.near - 0.05) return `"${label(hit.path)}" is in between, ${r3(hit.distance)} m out`;
  return null;
}

/**
 * Is there a floor under the room at its floor level? A trimmed dev copy can hold the room group alone, with no
 * building around it (Windows, 2026-11-13: UMD_DEV_1F_reception.skp has no floor, walls or columns). Then the
 * collision check can't see the building either, and that must be said, not passed over in silence.
 * Probes straight down at the four quarter points of the room's box.
 */
export async function floorUnderRoom(client: BridgeClient, summary: RoomSummary): Promise<boolean> {
  const b = summary.room.bounds;
  const z = Math.max(b.max[2], summary.floor.z + 2);
  for (const fx of [0.25, 0.75]) {
    for (const fy of [0.25, 0.75]) {
      const from: [number, number, number] = [b.min[0] + (b.max[0] - b.min[0]) * fx, b.min[1] + (b.max[1] - b.min[1]) * fy, z];
      const res = await client.call("measure", { from, direction: "down", maxDistance: z - summary.floor.z + 1, allHits: true, maxHits: 20 });
      if (!res.ok) throw new Error(`floor probe failed: ${res.error.code}: ${res.error.message}`);
      if (res.data.hits.some((h) => Math.abs(h.point[2] - summary.floor.z) <= FLOOR_TOLERANCE)) return true;
    }
  }
  return false;
}

/** Picks the first clear standpoint for every screenshot in the plan (changes the plan in place). Lines for the report. */
export async function checkViews(client: BridgeClient, plan: Plan, floorKnown = true): Promise<string[]> {
  const lines: string[] = [];
  if (!floorKnown && plan.actions.some((a) => a.viewOptions?.length)) {
    lines.push("VIEWS: this model has no floor under the room, so standpoints are checked only for things in between, not for a floor to stand on");
  }
  for (const a of plan.actions) {
    if (a.tool !== "captureView" || !a.viewOptions?.length) continue;
    const ids = a.viewOf ?? [];
    const what = ids.length ? ids.join("+") : "the room";
    const tried: string[] = [];
    let chosen: ViewOption | null = null;
    for (const o of a.viewOptions) {
      const why = await viewProblem(client, o, floorKnown);
      if (!why) {
        chosen = o;
        break;
      }
      tried.push(`${o.side}: ${why}`);
    }
    a.warnings = a.warnings.filter((w) => !w.startsWith("every standpoint is blocked"));
    if (!chosen) {
      a.warnings.push(`no side gives a clear eye-level view of ${what} in the real model, so the picture may show what is in the way (${tried.join("; ")})`);
      lines.push(`VIEW ${what}: no clear side (${tried.join("; ")})`);
      continue;
    }
    a.args = { ...a.args, camera: { eye: chosen.eye, target: chosen.target, fov: chosen.fov } };
    a.title = ids.length ? `SCREENSHOT of ${ids.join("+")} (${describeView(chosen, ids)})` : `SCREENSHOT of the room (eye level, from its ${chosen.side} side)`;
    a.details = [
      `camera at ${chosen.eye.join(", ")}, looking at ${chosen.target.join(", ")} (metres), field of view ${chosen.fov}°`,
      "checked against the real model: the camera stands on the floor and nothing is in between",
    ];
    lines.push(`VIEW ${what}: from the ${chosen.side}, ${chosen.near} m away${tried.length ? ` (not from the ${tried.join("; ")})` : ""}`);
  }
  return lines;
}
