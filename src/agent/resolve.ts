import { TOOLS, type Bounds, type ToolName, type Vec2 } from "../protocol/tools";
import type { RoomSummary, SummaryItem } from "../summary/roomSummary";
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

export type ResolveOptions = { runId: string; briefName: string };

export function resolveDraft(draft: Draft, summary: RoomSummary, opts: ResolveOptions): Plan {
  const refs = new Map(summary.items.map((it) => [it.ref, it]));
  const built = new Map<string, Built>();
  const hiddenTags = new Set<string>();
  const actions: Action[] = [];
  const errors: string[] = [];
  const floorZ = summary.floor.z;
  const jobGroup = `AGENT ${opts.briefName} ${opts.runId}`;
  let savedAt: number | null = null;

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
    if (step.op !== "build" && step.op !== "replace" && step.op !== "save") continue;
    const { line: _line, ...rest } = step;
    const key = JSON.stringify(step.op === "build" ? { ...rest, id: "" } : rest);
    if (seen.has(key)) errors.push(`line ${step.line}: the same ${step.op} step appears more than once (first at line ${seen.get(key)})`);
    else seen.set(key, step.line);
  }
  const tagFlips = draft.steps.filter((st) => st.op === "hideTag" || st.op === "showTag").length;
  if (tagFlips > 6) errors.push(`${tagFlips} tag hide/show steps: the plan is repeating itself`);
  const shots = draft.steps.filter((st) => st.op === "screenshot").length;
  if (shots > 3) errors.push(`${shots} screenshots: the plan is repeating itself`);

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

        const warnings: string[] = [];
        const room = summary.room.bounds;
        if (rect.x0 < room.min[0] - 0.001 || rect.x1 > room.max[0] + 0.001 || rect.y0 < room.min[1] - 0.001 || rect.y1 > room.max[1] + 0.001) {
          warnings.push("it reaches outside the room's box");
        }
        if (z1 > room.max[2] + 0.001) warnings.push(`its top (z ${fmt(z1)}) is above the room's box`);
        for (const it of summary.items) {
          if (it.visible && overlaps(box, it.bounds)) {
            warnings.push(`its box overlaps ${it.ref} "${short(it.name)}" (boxes only: check the screenshot)`);
          }
        }
        for (const [id, other] of built) {
          if (id === step.id) continue;
          const ob: Bounds = { min: [other.rect.x0, other.rect.y0, other.z0], max: [other.rect.x1, other.rect.y1, other.z1] };
          if (overlaps(box, ob)) warnings.push(`it overlaps ${id} "${other.name}" from this plan`);
        }

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

function place(
  p: Placement,
  step: Extract<DraftStep, { op: "build" }>,
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
const fmt = (v: number) => round(v).toFixed(3).replace(/\.?0+$/, "");
const fmtSize = (s: number[]) => s.map(fmt).join(" x ");
const short = (name: string) => (name.length > 40 ? `${name.slice(0, 40)}…` : name);
const boxText = (b: Bounds) =>
  `x ${fmt(b.min[0])}..${fmt(b.max[0])}  y ${fmt(b.min[1])}..${fmt(b.max[1])}  z ${fmt(b.min[2])}..${fmt(b.max[2])}`;
const safeName = (s: string) => s.replace(/[^A-Za-z0-9_-]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 60) || "copy";
