import { TOOLS, type Bounds, type ToolName, type Vec2 } from "../protocol/tools";
import type { RoomSummary, SummaryItem } from "../summary/roomSummary";
import { fitComponent, fitProblem, turnedSize, type Catalog, type CatalogEntry } from "./catalog";
import type { Draft, DraftStep, Placement } from "./draft";

/**
 * Step 2c: turns the model's draft into exact, checked tool calls.
 *
 * All arithmetic happens here, in code: "1.2 m east of R1, 0.7 east-west, 3.0 north-south"
 * becomes a footprint in world metres. Every resulting call is checked with the tool's
 * own Zod schema, and every new shape is compared with the boxes of the existing items.
 * Problems that make the plan impossible are `errors`; things you should look at are `warnings`.
 */

export type Action = {
  n: number;
  line: number;
  title: string;
  tool: ToolName;
  args: Record<string, unknown>;
  details: string[];
  warnings: string[];
  builds?: string; // step id this action creates (its entityId is needed later)
  box?: Bounds; // the planned world box of what this action builds or places (for the checks)
  targetsStep?: string; // fill args.target with the entityId of this step when running
  zoomToJobGroup?: boolean; // screenshot: frame the new shapes instead of the whole room, once they exist
};

export type Plan = {
  runId: string;
  jobGroup: string;
  floorZ: number;
  modelPath: string;
  actions: Action[];
  errors: string[];
  notDone: Draft["notDone"];
};

type Rect = { x0: number; y0: number; x1: number; y1: number };
type Built = { rect: Rect; z0: number; z1: number; name: string };

export type ResolveOptions = { runId: string; briefName: string; catalog?: Catalog };

export function resolveDraft(draft: Draft, summary: RoomSummary, opts: ResolveOptions): Plan {
  const refs = new Map(summary.items.map((it) => [it.ref, it]));
  const built = new Map<string, Built>();
  const hiddenTags = new Set<string>();
  const actions: Action[] = [];
  const errors: string[] = [];
  const floorZ = summary.floor.z;
  const jobGroup = `AGENT ${opts.briefName} ${opts.runId}`;
  let savedAt: number | null = null;

  /** Things to look at for a new box: outside the room, above it, overlapping outer boxes or other new blocks. */
  const boxWarnings = (box: Bounds, id: string): string[] => {
    const warnings: string[] = [];
    const room = summary.room.bounds;
    if (box.min[0] < room.min[0] - 0.001 || box.max[0] > room.max[0] + 0.001 || box.min[1] < room.min[1] - 0.001 || box.max[1] > room.max[1] + 0.001) {
      warnings.push("it reaches outside the room's box");
    }
    if (box.max[2] > room.max[2] + 0.001) warnings.push(`its top (z ${fmt(box.max[2])}) is above the room's box`);
    for (const it of summary.items) {
      if (it.visible && overlaps(box, it.bounds)) warnings.push(`its box overlaps ${it.ref} "${short(it.name)}" (boxes only: check the screenshot)`);
    }
    for (const [other, b] of built) {
      if (other === id) continue;
      const ob: Bounds = { min: [b.rect.x0, b.rect.y0, b.z0], max: [b.rect.x1, b.rect.y1, b.z1] };
      if (overlaps(box, ob)) warnings.push(`it overlaps ${other} "${b.name}" from this plan`);
    }
    return warnings;
  };

  const add = (a: Omit<Action, "n" | "warnings"> & { warnings?: string[] }) => {
    actions.push({ warnings: [], ...a, n: actions.length + 1 });
  };
  const item = (ref: string, step: DraftStep): SummaryItem | undefined => {
    const it = refs.get(ref);
    if (!it) errors.push(`line ${step.line}: ${ref} is not in the room summary (there are R1 to R${summary.items.length})`);
    return it;
  };

  // A small model can get stuck repeating itself. Building or replacing the same thing twice is never
  // intended. Screenshots and tag hide/show may repeat legitimately (Windows, 2026-11-11: a stray screenshot
  // in change 1 made the correct screenshot in change 8 "a duplicate", and the plan lost its save),
  // so for those only a runaway count is an error.
  const seen = new Map<string, number>();
  for (const step of draft.steps) {
    if (step.op !== "build" && step.op !== "replace" && step.op !== "save" && step.op !== "scene") continue;
    const { line: _line, ...rest } = step;
    const key = JSON.stringify(step.op === "build" ? { ...rest, id: "" } : step.op === "scene" ? { op: "scene", name: step.name.toLowerCase() } : rest);
    if (seen.has(key)) errors.push(`line ${step.line}: the same ${step.op} step appears more than once (first at line ${seen.get(key)})`);
    else seen.set(key, step.line);
  }
  const tagFlips = draft.steps.filter((st) => st.op === "hideTag" || st.op === "showTag").length;
  if (tagFlips > 6) errors.push(`${tagFlips} tag hide/show steps: the plan is repeating itself`);
  const shots = draft.steps.filter((st) => st.op === "screenshot").length;
  if (shots > 3) errors.push(`${shots} screenshots: the plan is repeating itself`);
  const sceneCount = draft.steps.filter((st) => st.op === "scene").length;
  if (sceneCount > 8) errors.push(`${sceneCount} scenes: the plan is repeating itself`);

  for (const step of draft.steps) {
    if (savedAt !== null && step.op !== "save") {
      errors.push(`line ${step.line}: "${step.op}" comes after the save, so it would not be in the saved copy`);
    }
    switch (step.op) {
      case "replace": {
        const it = item(step.target, step);
        if (!it) break;
        if (!it.canChange) errors.push(`line ${step.line}: ${it.ref} sits inside a shared component and can't be changed on its own`);
        add({
          line: step.line,
          title: `HIDE AS REPLACED  ${it.ref} "${it.name}"`,
          tool: "moveToReplaced",
          args: { target: { persistentId: it.persistentId }, replacedBy: `${opts.briefName} line ${step.line}`.slice(0, 60) },
          details: [
            `really contains: ${it.contents.slice(0, 6).join("; ") || "(no named parts)"}`,
            `size ${fmtSize(it.size)} at ${boxText(it.bounds)}`,
            "it is hidden on a zz_REPLACED tag, not deleted",
          ],
          warnings: [...it.warnings],
        });
        break;
      }

      case "build": {
        if (built.has(step.id)) {
          errors.push(`line ${step.line}: step id ${step.id} is used twice`);
          break;
        }
        const placed = place(step.placement, step, refs, built, floorZ, errors);
        if (!placed) break;
        const { rect, z0, where } = placed;
        const z1 = z0 + step.height;
        built.set(step.id, { rect, z0, z1, name: step.name });
        const box: Bounds = { min: [rect.x0, rect.y0, z0], max: [rect.x1, rect.y1, z1] };
        const size: [number, number, number] = [rect.x1 - rect.x0, rect.y1 - rect.y0, step.height];

        const warnings = boxWarnings(box, step.id);

        add({
          line: step.line,
          title: `BUILD ${step.id} "${step.name}"  ${fmtSize(size)} m`,
          tool: "createPrism",
          args: {
            jobGroup,
            name: step.name,
            tag: step.tag,
            points: rectPoints(rect),
            z0: round(z0),
            z1: round(z1),
          },
          details: [where, `at ${boxText(box)}`, `tag: ${step.tag}`],
          warnings,
          builds: step.id,
          box: roundBox(box),
        });
        if (step.material) {
          add({
            line: step.line,
            title: `PAINT ${step.id} with "${step.material.name}" (RGB ${step.material.rgb.join(", ")})`,
            tool: "applyMaterial",
            args: { target: { entityId: 1 }, material: step.material.name, color: step.material.rgb },
            details: ["creates the material from this colour if the model doesn't have it yet"],
            targetsStep: step.id,
          });
        }
        break;
      }

      case "place": {
        if (built.has(step.id)) {
          errors.push(`line ${step.line}: step id ${step.id} is used twice`);
          break;
        }
        const entry = findComponent(opts.catalog, step.component);
        if (!entry) {
          errors.push(
            opts.catalog?.size
              ? `line ${step.line}: "${step.component}" is not in the components folder; use a file name from the COMPONENTS list`
              : `line ${step.line}: no components catalog (run: npm run components)`,
          );
          break;
        }
        const roomHeight = summary.room.bounds.max[2] - (floorZ + step.base);
        const fit = fitComponent(entry.file, entry.size, { roomHeight, wanted: step.size, asDrawn: entry.asDrawn });
        if (!fit) {
          errors.push(`line ${step.line}: ${entry.file}: ${fitProblem(entry.file, entry.size, { roomHeight, wanted: step.size, asDrawn: entry.asDrawn })}`);
          break;
        }
        const [ew, ns, h] = turnedSize(fit.size, step.rotation);
        const placed = place({ ...step.placement, eastWest: ew, northSouth: ns }, step, refs, built, floorZ, errors);
        if (!placed) break;
        const { rect, z0, where } = placed;
        built.set(step.id, { rect, z0, z1: z0 + h, name: step.name });
        const box: Bounds = { min: [rect.x0, rect.y0, z0], max: [rect.x1, rect.y1, z0 + h] };
        add({
          line: step.line,
          title: `PLACE ${step.id} "${step.name}"  (${entry.file})  ${fmtSize([ew, ns, h])} m${step.rotation ? `, turned ${step.rotation}°` : ""}`,
          tool: "placeComponent",
          args: {
            jobGroup,
            file: entry.file,
            name: step.name,
            tag: step.tag,
            at: [round(rect.x0), round(rect.y0), round(z0)],
            rotation: step.rotation,
            scale: fit.scale,
          },
          details: [
            where,
            `at ${boxText(box)}`,
            `${fmt(ew)} m east-west, ${fmt(ns)} m north-south, top ${fmt(h)} m above the floor (a door is about 2.1 m)`,
            ...(fit.reason ? [`SCALED ×${fit.scale}: ${fit.reason} (your file is not changed)`] : []),
            `tag: ${step.tag}`,
            "a real 3D Warehouse component from your components folder",
          ],
          warnings: boxWarnings(box, step.id),
          builds: step.id,
          box: roundBox(box),
        });
        break;
      }

      case "hideTag":
      case "showTag": {
        const visible = step.op === "showTag";
        if (visible) hiddenTags.delete(step.tag);
        else hiddenTags.add(step.tag);
        add({
          line: step.line,
          title: `${visible ? "SHOW" : "HIDE"} TAG "${step.tag}"`,
          tool: "setTagVisibility",
          args: { tag: step.tag, visible },
          details: [],
        });
        break;
      }

      case "screenshot":
        add({
          line: step.line,
          title: "SCREENSHOT (iso view of the room)",
          tool: "captureView",
          args: { fileName: `${safeName(opts.briefName)}_${opts.runId}.png`, zoomTo: { persistentId: summary.room.persistentId } },
          details: ["frames the new shapes (or the whole room if nothing was built)"],
          zoomToJobGroup: true,
        });
        break;

      case "scene": {
        const cam = sceneCamera(step, summary, refs, errors);
        if (!cam) break;
        const hidden = [...new Set([...summary.tags.filter((tg) => !tg.visible).map((tg) => tg.name), ...hiddenTags])].filter((t) => !/^zz_REPLACED/i.test(t));
        const warnings = [...cam.warnings];
        const [ex, ey, ez] = cam.eye;
        if (step.from !== "above") {
          const inside = (b: Bounds) => ex > b.min[0] && ex < b.max[0] && ey > b.min[1] && ey < b.max[1] && ez > b.min[2] && ez < b.max[2];
          for (const it of summary.items) if (it.visible && inside(it.bounds)) warnings.push(`the camera stands inside the box of ${it.ref} "${short(it.name)}" (boxes only: look at the scene)`);
          for (const [id, b] of built) {
            if (inside({ min: [b.rect.x0, b.rect.y0, b.z0], max: [b.rect.x1, b.rect.y1, b.z1] })) warnings.push(`the camera stands inside ${id} "${b.name}" from this plan`);
          }
        }
        // Is the item the view looks at hidden behind something? (Windows, 2026-11-13: the "seated" view of Terrarium A
        // looked straight through Terrarium E.) Boxes at eye height only, so it is a warning: look at the scene.
        if (step.toward && step.from !== "above") {
          const blockers = sightBlockers(cam.eye, cam.target, step, summary, built);
          if (blockers.length) {
            const clear = Object.keys(COMPASS).filter((side) => {
              const other = sceneCamera({ ...step, from: side }, summary, refs, []);
              return other && sightBlockers(other.eye, other.target, { ...step, from: side }, summary, built).length === 0;
            });
            warnings.push(
              `the view of ${step.toward} is blocked by ${blockers.join(", ")} (boxes at eye height: look at the scene)` +
                (clear.length ? `; a clear view of it: from ${clear.join(", ")}` : "; no side of the room has a clear view of it"),
            );
          }
        }
        add({
          line: step.line,
          title: `SCENE "${step.name}"  (${cam.what})`,
          tool: "addScene",
          args: { name: step.name, eye: cam.eye, target: cam.target, fov: cam.fov },
          details: [
            `camera at ${cam.eye.map(fmt).join(", ")}, looking at ${cam.target.map(fmt).join(", ")} (metres), field of view ${cam.fov}°`,
            hidden.length ? `the scene keeps these tags hidden: ${hidden.join(", ")}` : "every tag is visible in this scene",
            "a new scene tab: D5 can render it; an existing scene with this name is never changed (this one gets \" (2)\")",
          ],
          warnings,
        });
        break;
      }

      case "save": {
        const base = safeName(step.fileName.replace(/\.skp$/i, ""));
        savedAt = actions.length;
        const stays = [...hiddenTags];
        add({
          line: step.line,
          title: `SAVE A COPY as ${base}_${opts.runId}.skp`,
          tool: "saveCopy",
          args: { fileName: `${base}_${opts.runId}.skp` },
          details: ["the run id is added so an earlier copy is never overwritten; the open model itself is not saved"],
          warnings: stays.length ? [`these tags are still hidden in the saved copy: ${stays.join(", ")}`] : [],
        });
        break;
      }
    }
  }

  // Every call must pass the tool's own checks before anything is sent.
  for (const a of actions) {
    const parsed = TOOLS[a.tool].args.safeParse(a.args);
    if (!parsed.success) {
      errors.push(`action ${a.n} (${a.tool}): ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
    }
  }
  if (!actions.some((a) => a.tool === "saveCopy")) errors.push("the plan never saves a copy, so the result would be lost");

  return { runId: opts.runId, jobGroup, floorZ, modelPath: summary.modelPath, actions, errors, notDone: draft.notDone };
}

/** Does the flat line from p to q cross the box's footprint? (slab test; touching an edge counts) */
export function segmentHitsBox(p: [number, number], q: [number, number], b: Bounds): boolean {
  let t0 = 0;
  let t1 = 1;
  for (let i = 0; i < 2; i++) {
    const d = q[i]! - p[i]!;
    if (Math.abs(d) < 1e-12) {
      if (p[i]! < b.min[i]! || p[i]! > b.max[i]!) return false;
      continue;
    }
    let a = (b.min[i]! - p[i]!) / d;
    let c = (b.max[i]! - p[i]!) / d;
    if (a > c) [a, c] = [c, a];
    t0 = Math.max(t0, a);
    t1 = Math.min(t1, c);
    if (t0 > t1) return false;
  }
  return true;
}

/** Items (and new blocks) standing between the camera and what it looks at, at eye height. */
function sightBlockers(
  eye: [number, number, number],
  target: [number, number, number],
  step: { from: string; toward?: string },
  summary: RoomSummary,
  built: Map<string, Built>,
): string[] {
  const [ex, ey, ez] = eye;
  const blocks = (b: Bounds) => ez > b.min[2] && ez < b.max[2] && segmentHitsBox([ex, ey], [target[0], target[1]], b);
  const out: string[] = [];
  for (const it of summary.items) {
    if (!it.visible || it.ref === step.toward || it.ref === step.from) continue;
    const b = it.bounds;
    if (ex >= b.min[0] && ex <= b.max[0] && ey >= b.min[1] && ey <= b.max[1]) continue; // a whole-area group the camera stands in
    if (blocks(b)) out.push(`${it.ref} "${short(it.name)}"`);
  }
  for (const [id, b] of built) if (blocks({ min: [b.rect.x0, b.rect.y0, b.z0], max: [b.rect.x1, b.rect.y1, b.z1] })) out.push(`${id} "${b.name}" from this plan`);
  return out;
}

const SCENE_INSET = 0.6; // the camera stands this far in from the side of the room (clear of a wall)
const COMPASS: Record<string, [number, number]> = {
  north: [0, 1], south: [0, -1], east: [1, 0], west: [-1, 0],
  northeast: [1, 1], northwest: [-1, 1], southeast: [1, -1], southwest: [-1, -1],
};

/**
 * Where a scene's camera stands and what it looks at, worked out from the room's box (never by the model).
 * Eye-level views look straight ahead (target at eye height), so walls stay vertical, like a designer's photo.
 */
export function sceneCamera(
  step: { line: number; name: string; from: string; toward?: string; eyeHeight: number },
  summary: RoomSummary,
  refs: Map<string, SummaryItem>,
  errors: string[],
): { eye: [number, number, number]; target: [number, number, number]; fov: number; what: string; warnings: string[] } | null {
  const room = summary.room.bounds;
  const mid = (b: Bounds, i: number) => (b.min[i]! + b.max[i]!) / 2;
  const warnings: string[] = [];
  let toward: SummaryItem | undefined;
  if (step.toward) {
    toward = refs.get(step.toward);
    if (!toward) {
      errors.push(`line ${step.line}: the scene looks toward ${step.toward}, which is not in the room summary`);
      return null;
    }
  }
  const r3 = (p: number[]) => p.map(round) as [number, number, number];

  if (step.from === "above") {
    const box = toward?.bounds ?? room;
    const c = [mid(box, 0), mid(box, 1), mid(box, 2)];
    const diag = Math.hypot(box.max[0] - box.min[0], box.max[1] - box.min[1], box.max[2] - box.min[2]);
    const fov = 35;
    const distance = (Math.max(diag / 2, 1) / Math.tan(((fov / 2) * Math.PI) / 180)) * 1.15;
    const d = [1, -1, 0.8];
    const len = Math.hypot(d[0]!, d[1]!, d[2]!);
    return {
      eye: r3(c.map((v, i) => v + (d[i]! / len) * distance)),
      target: r3(c),
      fov,
      what: `from above the south-east corner, the whole ${toward ? `${toward.ref} "${short(toward.name)}"` : "room"}`,
      warnings,
    };
  }

  const z = summary.floor.z + step.eyeHeight;
  const inset = (v: number, i: number) => Math.min(Math.max(v, room.min[i]! + SCENE_INSET), room.max[i]! - SCENE_INSET);
  let eye: [number, number];
  let where: string;
  const compass = COMPASS[step.from];
  if (compass) {
    eye = [
      compass[0] > 0 ? room.max[0] - SCENE_INSET : compass[0] < 0 ? room.min[0] + SCENE_INSET : mid(room, 0),
      compass[1] > 0 ? room.max[1] - SCENE_INSET : compass[1] < 0 ? room.min[1] + SCENE_INSET : mid(room, 1),
    ];
    where = `eye level (${fmt(step.eyeHeight)} m) from the ${step.from} ${compass[0] && compass[1] ? "corner" : "side"} of the room`;
  } else {
    const from = refs.get(step.from);
    if (!from) {
      errors.push(`line ${step.line}: the scene stands at ${step.from}, which is not in the room summary`);
      return null;
    }
    // Step out of the item toward what the view looks at (or the room's middle), then a little further.
    const c = [mid(from.bounds, 0), mid(from.bounds, 1)];
    const goal = toward ? [mid(toward.bounds, 0), mid(toward.bounds, 1)] : [mid(room, 0), mid(room, 1)];
    let dx = goal[0]! - c[0]!;
    let dy = goal[1]! - c[1]!;
    const len = Math.hypot(dx, dy);
    if (len < 0.01) {
      errors.push(`line ${step.line}: ${from.ref} is in the middle of the room, so "from ${from.ref}" has no direction; use a side of the room instead`);
      return null;
    }
    dx /= len;
    dy /= len;
    const half = [(from.bounds.max[0] - from.bounds.min[0]) / 2, (from.bounds.max[1] - from.bounds.min[1]) / 2];
    const exit = Math.min(Math.abs(dx) > 1e-9 ? half[0]! / Math.abs(dx) : Infinity, Math.abs(dy) > 1e-9 ? half[1]! / Math.abs(dy) : Infinity);
    const raw: [number, number] = [c[0]! + dx * (exit + SCENE_INSET), c[1]! + dy * (exit + SCENE_INSET)];
    eye = [inset(raw[0], 0), inset(raw[1], 1)];
    if (Math.hypot(eye[0] - raw[0], eye[1] - raw[1]) > 0.01) warnings.push("the camera was moved to stay inside the room");
    where = `eye level (${fmt(step.eyeHeight)} m) just inside ${from.ref} "${short(from.name)}"`;
  }
  const target: [number, number] = toward ? [mid(toward.bounds, 0), mid(toward.bounds, 1)] : [mid(room, 0), mid(room, 1)];
  if (Math.hypot(target[0] - eye[0], target[1] - eye[1]) < 0.5) {
    errors.push(`line ${step.line}: the scene "${step.name}" would stand on top of what it looks at; choose another side`);
    return null;
  }
  return {
    eye: r3([eye[0], eye[1], z]),
    target: r3([target[0], target[1], z]),
    fov: 55,
    what: `${where}, looking at ${toward ? `${toward.ref} "${short(toward.name)}"` : "the middle of the room"}`,
    warnings,
  };
}

/** The catalog entry for a file name; small models sometimes drop ".skp" or change the case. */
function findComponent(catalog: Catalog | undefined, name: string): CatalogEntry | undefined {
  if (!catalog) return undefined;
  const exact = catalog.get(name);
  if (exact) return exact;
  const want = name.trim().toLowerCase().replace(/\.skp$/, "");
  return [...catalog.values()].find((c) => c.file.toLowerCase().replace(/\.skp$/, "") === want);
}

function place(
  p: Placement,
  step: { line: number; id: string; base: number },
  refs: Map<string, SummaryItem>,
  built: Map<string, Built>,
  floorZ: number,
  errors: string[],
): { rect: Rect; z0: number; where: string } | null {
  if (p.kind === "onTop") {
    const under = built.get(p.of);
    if (!under) {
      errors.push(`line ${step.line}: ${step.id} goes on top of ${p.of}, which is not built before it`);
      return null;
    }
    const o = p.overhang;
    const r = under.rect;
    return {
      rect: { x0: r.x0 - o, y0: r.y0 - o, x1: r.x1 + o, y1: r.y1 + o },
      z0: under.z1,
      where: `on top of ${p.of} "${under.name}", ${fmt(o)} m overhang on every side`,
    };
  }

  const anchor = refs.get(p.anchor);
  if (!anchor) {
    errors.push(`line ${step.line}: ${step.id} is placed beside ${p.anchor}, which is not in the room summary`);
    return null;
  }
  const a = anchor.bounds;
  const cx = (a.min[0] + a.max[0]) / 2 + p.shift;
  const cy = (a.min[1] + a.max[1]) / 2 + p.shift;
  let rect: Rect;
  switch (p.side) {
    case "east":
      rect = { x0: a.max[0] + p.gap, x1: a.max[0] + p.gap + p.eastWest, y0: cy - p.northSouth / 2, y1: cy + p.northSouth / 2 };
      break;
    case "west":
      rect = { x0: a.min[0] - p.gap - p.eastWest, x1: a.min[0] - p.gap, y0: cy - p.northSouth / 2, y1: cy + p.northSouth / 2 };
      break;
    case "north":
      rect = { y0: a.max[1] + p.gap, y1: a.max[1] + p.gap + p.northSouth, x0: cx - p.eastWest / 2, x1: cx + p.eastWest / 2 };
      break;
    case "south":
      rect = { y0: a.min[1] - p.gap - p.northSouth, y1: a.min[1] - p.gap, x0: cx - p.eastWest / 2, x1: cx + p.eastWest / 2 };
      break;
  }
  const shift = p.shift ? `, shifted ${fmt(Math.abs(p.shift))} m ${p.shift > 0 ? (p.side === "north" || p.side === "south" ? "east" : "north") : p.side === "north" || p.side === "south" ? "west" : "south"}` : "";
  return {
    rect,
    z0: floorZ + step.base,
    where: `${fmt(p.gap)} m ${p.side} of ${anchor.ref} "${short(anchor.name)}", centred on it${shift}; ${step.base ? `${fmt(step.base)} m above` : "standing on"} the floor (z ${fmt(floorZ)})`,
  };
}

/** Counter-clockwise seen from above, so SketchUp's top face points up. */
function rectPoints(r: Rect): Vec2[] {
  return [
    [round(r.x0), round(r.y0)],
    [round(r.x1), round(r.y0)],
    [round(r.x1), round(r.y1)],
    [round(r.x0), round(r.y1)],
  ];
}

/** True when two boxes share real volume (just touching does not count). */
export function overlaps(a: Bounds, b: Bounds, tol = 0.001): boolean {
  return [0, 1, 2].every((i) => a.min[i]! < b.max[i]! - tol && b.min[i]! < a.max[i]! - tol);
}

/** Text shown to you before you approve. */
export function renderPlan(plan: Plan): string {
  const lines = [`PLAN ${plan.runId}  (new shapes go in group "${plan.jobGroup}")`, `model: ${plan.modelPath}`, ""];
  for (const a of plan.actions) {
    lines.push(`[${a.n}] brief line ${a.line}: ${a.title}`);
    for (const d of a.details) lines.push(`      ${d}`);
    for (const w of a.warnings) lines.push(`      WARNING: ${w}`);
  }
  if (plan.notDone.length) {
    lines.push("", "NOT DONE:");
    for (const n of plan.notDone) lines.push(`  - ${n.line ? `line ${n.line}: ` : ""}${n.what}: ${n.reason}`);
  }
  if (plan.errors.length) {
    lines.push("", "ERRORS (nothing will run until these are fixed):");
    for (const e of plan.errors) lines.push(`  - ${e}`);
  }
  return lines.join("\n");
}

const round = (v: number) => Math.round(v * 1000) / 1000;
const roundBox = (b: Bounds): Bounds => ({ min: b.min.map(round) as Bounds["min"], max: b.max.map(round) as Bounds["max"] });
const fmt = (v: number) => round(v).toFixed(3).replace(/\.?0+$/, "");
const fmtSize = (s: number[]) => s.map(fmt).join(" x ");
const short = (name: string) => (name.length > 40 ? `${name.slice(0, 40)}…` : name);
const boxText = (b: Bounds) =>
  `x ${fmt(b.min[0])}..${fmt(b.max[0])}  y ${fmt(b.min[1])}..${fmt(b.max[1])}  z ${fmt(b.min[2])}..${fmt(b.max[2])}`;
const safeName = (s: string) => s.replace(/[^A-Za-z0-9_-]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 60) || "copy";
