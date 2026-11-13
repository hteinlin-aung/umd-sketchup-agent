import type { Plan } from "../agent/resolve";
import { describeView, type ViewOption } from "../agent/views";
import type { BridgeClient } from "../bridge/client";

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

/** Why this standpoint is no good in the real model, or null if it is. */
export async function viewProblem(client: BridgeClient, o: ViewOption): Promise<string | null> {
  const down = await client.call("measure", { from: o.eye, direction: "down", maxDistance: 5 });
  if (!down.ok) throw new Error(`view check failed: ${down.error.code}: ${down.error.message}`);
  const floor = down.data.hits[0];
  if (!floor) return "no floor under it";
  if (Math.abs(floor.point[2] - o.floorZ) > FLOOR_TOLERANCE) return `it would stand on "${label(floor.path)}" at z ${r3(floor.point[2])}, not on the floor`;
  if (o.near <= 0) return null; // a view of the whole room: nothing particular to see past
  const sight = await client.call("measure", { from: [o.eye[0], o.eye[1], o.rayZ], direction: o.look, maxDistance: o.near });
  if (!sight.ok) throw new Error(`view check failed: ${sight.error.code}: ${sight.error.message}`);
  const hit = sight.data.hits[0];
  if (hit && hit.distance < o.near - 0.05) return `"${label(hit.path)}" is in between, ${r3(hit.distance)} m out`;
  return null;
}

/** Picks the first clear standpoint for every screenshot in the plan (changes the plan in place). Lines for the report. */
export async function checkViews(client: BridgeClient, plan: Plan): Promise<string[]> {
  const lines: string[] = [];
  for (const a of plan.actions) {
    if (a.tool !== "captureView" || !a.viewOptions?.length) continue;
    const ids = a.viewOf ?? [];
    const what = ids.length ? ids.join("+") : "the room";
    const tried: string[] = [];
    let chosen: ViewOption | null = null;
    for (const o of a.viewOptions) {
      const why = await viewProblem(client, o);
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
