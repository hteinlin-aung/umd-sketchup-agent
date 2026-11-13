import type { Bounds } from "../protocol/tools";
import type { RoomSummary } from "../summary/roomSummary";

/**
 * Week 3: the picture after a build is an eye-level view from where a person could stand, aimed at the new pieces.
 *
 * The iso view from outside framed roofs (Windows, 2026-11-13, brief 5), so it is gone. Instead the new pieces are
 * grouped (pieces close together share one picture) and each group gets a short list of standpoints, best first:
 * in front of its long face before its ends, and the side toward the room's middle first. Every standpoint looks
 * straight along an axis, so the real model can check it with `measure` rays before the plan is shown
 * (src/geometry/views.ts). The code picks; the model never writes a camera.
 */

export type Side = "north" | "south" | "east" | "west";
export type Camera = { eye: [number, number, number]; target: [number, number, number]; fov: number };
export type ViewOption = Camera & {
  side: Side; // where the camera stands, seen from the pieces
  look: Side; // the direction it looks (the opposite side): the direction of the check ray
  near: number; // metres from the eye to the near face of the group, along `look`
  rayZ: number; // height of the check ray: through the pieces, not over them
  floorZ: number; // the floor the camera must stand on
};
export type ViewGroup = { ids: string[]; box: Bounds; options: ViewOption[] };

export const VIEW_FOV = 60; // SketchUp measures it top to bottom
const ASPECT = 1600 / 900; // the default picture size
const EYE = 1.6;
const GROUP_GAP = 4; // pieces closer than this share one picture
const MIN_DISTANCE = 3.0; // a level camera at 1.6 m sees the floor from about 2.8 m out
const MAX_DISTANCE = 9;
const MARGIN = 0.6; // around the group, so it doesn't touch the picture's edge

const OPPOSITE: Record<Side, Side> = { north: "south", south: "north", east: "west", west: "east" };
const H_FOV = 2 * Math.atan(Math.tan(((VIEW_FOV / 2) * Math.PI) / 180) * ASPECT); // radians, side to side

const round = (v: number) => Math.round(v * 1000) / 1000;
const union = (a: Bounds, b: Bounds): Bounds => ({
  min: [0, 1, 2].map((i) => Math.min(a.min[i]!, b.min[i]!)) as Bounds["min"],
  max: [0, 1, 2].map((i) => Math.max(a.max[i]!, b.max[i]!)) as Bounds["max"],
});
/** Plan distance between two boxes (0 if they touch or overlap). */
const gap = (a: Bounds, b: Bounds) => Math.hypot(...[0, 1].map((i) => Math.max(0, a.min[i]! - b.max[i]!, b.min[i]! - a.max[i]!)));

/** Pieces closer than GROUP_GAP end up in one group (and one picture). Order follows the plan. */
export function groupPieces(pieces: { id: string; box: Bounds }[]): { ids: string[]; box: Bounds }[] {
  const groups: { ids: string[]; box: Bounds }[] = [];
  for (const p of pieces) {
    const near = groups.filter((g) => gap(g.box, p.box) <= GROUP_GAP);
    if (near.length === 0) {
      groups.push({ ids: [p.id], box: p.box });
      continue;
    }
    const merged = near.reduce((acc, g) => ({ ids: [...acc.ids, ...g.ids], box: union(acc.box, g.box) }), { ids: [] as string[], box: p.box });
    merged.ids.push(p.id);
    const first = groups.indexOf(near[0]!);
    for (const g of near) groups.splice(groups.indexOf(g), 1);
    groups.splice(first, 0, { ids: merged.ids.sort((a, b) => pieces.findIndex((x) => x.id === a) - pieces.findIndex((x) => x.id === b)), box: merged.box });
  }
  return groups;
}

/** The standpoints for one group, best first. */
export function viewOptions(box: Bounds, summary: RoomSummary): ViewOption[] {
  const floorZ = summary.floor.z;
  const z = round(floorZ + EYE);
  const cx = (box.min[0] + box.max[0]) / 2;
  const cy = (box.min[1] + box.max[1]) / 2;
  const sx = box.max[0] - box.min[0];
  const sy = box.max[1] - box.min[1];
  const height = box.max[2] - Math.max(box.min[2], floorZ);
  const rayZ = round(Math.max(box.min[2], floorZ) + Math.min(Math.max(height / 2, 0.15), 1.0));
  const room = summary.room.bounds;
  const middle = [(room.min[0] + room.max[0]) / 2, (room.min[1] + room.max[1]) / 2];

  const option = (side: Side): ViewOption => {
    const across = side === "north" || side === "south" ? sx : sy; // the group's width in the picture
    const distance = Math.min(MAX_DISTANCE, Math.max(MIN_DISTANCE, (across / 2 + MARGIN) / Math.tan(H_FOV / 2)));
    const face = { north: box.max[1], south: box.min[1], east: box.max[0], west: box.min[0] }[side];
    const eye: [number, number, number] =
      side === "north" || side === "south" ? [cx, face + (side === "north" ? distance : -distance), z] : [face + (side === "east" ? distance : -distance), cy, z];
    return { eye: eye.map(round) as Camera["eye"], target: [round(cx), round(cy), z], fov: VIEW_FOV, side, look: OPPOSITE[side], near: round(distance), rayZ, floorZ };
  };
  const towardMiddle = (a: ViewOption, b: ViewOption) =>
    Math.hypot(a.eye[0] - middle[0]!, a.eye[1] - middle[1]!) - Math.hypot(b.eye[0] - middle[0]!, b.eye[1] - middle[1]!);
  // In front of the long face first (you see the piece, not its end), then the ends.
  const front: Side[] = sx >= sy ? ["north", "south"] : ["east", "west"];
  const ends: Side[] = sx >= sy ? ["east", "west"] : ["north", "south"];
  return [...front.map(option).sort(towardMiddle), ...ends.map(option).sort(towardMiddle)];
}

export function describeView(o: ViewOption, ids: string[]): string {
  return `eye level (${EYE} m), ${o.near} m ${o.side} of ${ids.join("+")}, looking ${o.look}`;
}
