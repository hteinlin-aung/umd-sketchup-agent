import type { Draft, DraftStep } from "../agent/draft";
import type { Plan } from "../agent/resolve";
import type { BridgeClient } from "../bridge/client";
import type { Bounds, DataOf } from "../protocol/tools";
import type { RoomSummary } from "../summary/roomSummary";

/**
 * Week 3: geometry checks against the REAL model, not the outer boxes in the summary.
 *
 * Before running: for every new block, SketchUp lists the actual parts its box would cut into (the
 * smallest groups/components, e.g. "glass E" of a terrarium, not the whole terrarium). Touching is fine.
 * A collision gets one predefined fix: slide the block along its wall until it is clear (+5 cm), at most
 * 3 tries and at most 2 m in total. What can't be fixed that way is reported and the plan can't run.
 *
 * After running: everything is read back. Each new block must exist at its planned size, and nothing in
 * the room may have changed except the items the plan took out.
 */

type Found = DataOf<"findEntities">["matches"][number];

export type Collision = { step: string; with: string; path: string[]; bounds: Bounds; overlap: [number, number, number] };
export type Repair = { step: string; line: number; moved: number; direction: string; because: string };
export type CheckResult = { draft: Draft; plan: Plan; repairs: Repair[]; unresolved: Collision[] };

const TOUCH = 0.01; // boxes that only touch (or overlap by under 1 cm) don't count
// A leaf this much bigger than the new block, and this big in itself, is a SHELL, not a part: raw geometry whose
// one box covers a whole room ("1F Walls & partitions > Group#276" covers the breathing room, the 1F floor plate
// covers the building). Its box is mostly empty space, so its faces are checked instead (Windows, 2026-11-13).
const SHELL_TIMES = 10; // ... bigger than the block's footprint
const SHELL_AREA = 20; // ... and at least this many square metres itself
const MAX_FACES = 2_000; // more faces than this in the block's box: say so, never "clear"
const CLEAR = 0.05; // a repaired block keeps 5 cm from what it hit
const MAX_TRIES = 3;
const MAX_MOVE = 2.0; // further than this changes the design: report instead

const shrink = (b: Bounds, d: number): Bounds => ({
  min: b.min.map((v) => v + d) as Bounds["min"],
  max: b.max.map((v) => v - d) as Bounds["max"],
});

const isPrefix = (a: string[], b: string[]) => a.length < b.length && a.every((n, i) => n === b[i]);

const footprint = (b: Bounds) => (b.max[0]! - b.min[0]!) * (b.max[1]! - b.min[1]!);

/** A leaf whose box is mostly empty space: too big to be a part of the model, so its faces decide. */
export function isShell(leaf: Bounds, block: Bounds): boolean {
  const area = footprint(leaf);
  return area >= SHELL_AREA && area >= footprint(block) * SHELL_TIMES;
}

/**
 * Does the block really cut into this face? A face is flat, so on its thin axis the two boxes can never overlap
 * by 1 cm: there the block must CROSS the face's plane. A block standing on a floor face, or set against a wall
 * face, only touches it, and that is not a collision.
 */
export function faceIsCut(block: Bounds, face: Bounds): boolean {
  return [0, 1, 2].every((i) => {
    const thin = face.max[i]! - face.min[i]! < TOUCH;
    if (thin) return face.min[i]! > block.min[i]! + TOUCH && face.max[i]! < block.max[i]! - TOUCH;
    return Math.min(block.max[i]!, face.max[i]!) - Math.max(block.min[i]!, face.min[i]!) > TOUCH;
  });
}

/** The real parts each new block of the plan would cut into. Read-only. */
export async function findCollisions(client: BridgeClient, plan: Plan, summary: RoomSummary): Promise<Collision[]> {
  const hiddenTags = new Set(summary.tags.filter((t) => !t.visible).map((t) => t.name));
  const removed: string[][] = []; // paths of items this plan takes out before the block is built
  const out: Collision[] = [];

  for (const a of plan.actions) {
    if (a.tool === "moveToReplaced") {
      const pid = (a.args.target as { persistentId?: number }).persistentId;
      const item = summary.items.find((it) => it.persistentId === pid);
      if (item) removed.push(item.path);
      continue;
    }
    if (a.tool === "setTagVisibility") {
      if (a.args.visible) hiddenTags.delete(String(a.args.tag));
      else hiddenTags.add(String(a.args.tag));
      continue;
    }
    if (!a.builds || !a.box) continue; // a new block or a placed component
    const box = a.box;
    // The whole model, not just the room: in T133 the timber screen, the platforms and the walls that the first
    // brief-5 plan cut into all live in other groups (Windows, 2026-11-13). Only things near the block are looked
    // at, and since bridge 0.6.1 a group whose box misses is not opened, so this stays cheap.
    const res = await client.call("findEntities", { touches: shrink(box, TOUCH), maxDepth: 6, limit: 500 });
    if (!res.ok) throw new Error(`collision check failed: ${res.error.code}: ${res.error.message}`);

    const live = res.data.matches.filter(
      (m) => !m.hidden && !hiddenTags.has(m.tag) && !removed.some((p) => p.join("\u0000") === m.path.join("\u0000") || isPrefix(p, m.path)),
    );
    // Only real parts count: things with no smaller parts inside (just faces), or the deepest level searched.
    // A group whose outer box overlaps while none of its parts do is empty space (the Lounge bay's box
    // reaches the bench, its sofas don't).
    if (res.data.truncated) throw new Error(`collision check for ${a.builds}: too many parts in its box to check them all`);
    // A search that stopped at the bridge's scan limit saw only part of the model: "no collision" would be a guess.
    if (res.data.scanLimitHit) throw new Error(`collision check for ${a.builds}: the model was too big to search completely, so it was not checked`);
    const leaves = live.filter((m) => m.childCount === 0 || m.depth >= 6);
    for (const m of leaves) {
      if (isShell(m.bounds, box)) {
        out.push(...(await shellCollisions(client, a.builds, m, box, hiddenTags)));
        continue;
      }
      const overlap = [0, 1, 2].map((i) => Math.min(box.max[i]!, m.bounds.max[i]!) - Math.max(box.min[i]!, m.bounds.min[i]!)) as [number, number, number];
      if (overlap.every((v) => v > TOUCH)) out.push({ step: a.builds, with: label(m), path: m.path, bounds: m.bounds, overlap: overlap.map(round) as [number, number, number] });
    }
  }
  return out;
}

/** The faces of a shell that the block really cuts into, as collisions against the face's own box. */
async function shellCollisions(client: BridgeClient, step: string, shell: Found, box: Bounds, hiddenTags: Set<string>): Promise<Collision[]> {
  const res = await client.call("facesInBox", { target: { entityId: shell.entityId }, box: shrink(box, TOUCH), limit: MAX_FACES });
  if (!res.ok) throw new Error(`collision check for ${step}: reading the faces of "${label(shell)}" failed: ${res.error.code}: ${res.error.message}`);
  if (res.data.truncated || res.data.scanLimitHit) {
    throw new Error(
      `collision check for ${step}: "${label(shell)}" holds ${res.data.entityCount} things and was too big to read, so it was NOT checked ` +
        "(it is raw geometry, not a part: look at the screenshot, or build somewhere else)",
    );
  }
  const cut = res.data.faces.filter((f) => !hiddenTags.has(f.tag) && faceIsCut(box, f.bounds));
  if (cut.length === 0) return [];
  // One collision per shell: every face of it is the same wall or platform, and the repair slides clear of the lot.
  const bounds: Bounds = {
    min: [0, 1, 2].map((i) => Math.min(...cut.map((f) => f.bounds.min[i]!))) as Bounds["min"],
    max: [0, 1, 2].map((i) => Math.max(...cut.map((f) => f.bounds.max[i]!))) as Bounds["max"],
  };
  const overlap = [0, 1, 2].map((i) => round(Math.min(box.max[i]!, bounds.max[i]!) - Math.max(box.min[i]!, bounds.min[i]!))) as [number, number, number];
  return [{ step, with: `${label(shell)} (${cut.length} face${cut.length > 1 ? "s" : ""})`, path: shell.path, bounds, overlap }];
}

/**
 * Checks the plan and applies the one predefined fix (slide along the wall) where it can.
 * `resolve` turns a draft into a plan (resolveDraft with the run's options).
 */
export async function checkAndRepair(
  client: BridgeClient,
  draft: Draft,
  summary: RoomSummary,
  resolve: (d: Draft) => Plan,
  /** The brief's own rules (e.g. "1.8 m clear between them"), re-checked after any automatic move. */
  briefRules: (plan: Plan) => string[] = () => [],
): Promise<CheckResult> {
  const result = await repairLoop(client, draft, summary, resolve);
  if (result.repairs.length > 0) {
    for (const problem of briefRules(result.plan)) {
      result.plan.errors.push(`the automatic move broke the brief: ${problem}. Nothing was changed; adjust the brief or place it by hand`);
    }
  }
  return result;
}

async function repairLoop(client: BridgeClient, draft: Draft, summary: RoomSummary, resolve: (d: Draft) => Plan): Promise<CheckResult> {
  let current = draft;
  const repairs: Repair[] = [];
  const movedSoFar = new Map<number, number>(); // brief line -> metres moved so far

  for (let attempt = 1; attempt <= MAX_TRIES; attempt++) {
    const plan = resolve(current);
    const collisions = await findCollisions(client, plan, summary);
    if (collisions.length === 0) return { draft: current, plan: dropBoxOnlyWarnings(plan), repairs, unresolved: [] };

    let changed = false;
    const steps = current.steps.map((st) => ({ ...st })) as DraftStep[];
    const builds = steps.filter((s): s is Extract<DraftStep, { op: "build" | "place" }> => s.op === "build" || s.op === "place");
    const done = new Set<number>(); // brief lines already moved in this attempt
    for (const step of new Set(collisions.map((c) => c.step))) {
      const st = builds.find((s) => s.id === step);
      if (!st || st.placement.kind !== "beside" || done.has(st.line)) continue; // a top moves with its base
      // Blocks from the SAME brief change move together, so their spacing (a path between two kerbs) is kept.
      // Windows, 2026-11-12: one kerb moved alone and the 1.8 m clear path became 1.25 m without a word.
      const set = builds.filter((s) => s.line === st.line && s.placement.kind === "beside");
      const axisOf = (s: (typeof set)[number]) => (s.placement.kind === "beside" && (s.placement.side === "east" || s.placement.side === "west") ? 1 : 0);
      const axis = axisOf(st);
      if (set.some((s) => axisOf(s) !== axis)) continue; // can't slide them together: reported below
      let up = 0;
      let down = 0;
      const hitNames: string[] = [];
      for (const member of set) {
        const hits = collisions.filter((c) => c.step === member.id);
        if (hits.length === 0) continue;
        const box = plan.actions.find((a) => a.builds === member.id)!.box!;
        up = Math.max(up, ...hits.map((h) => h.bounds.max[axis]! - box.min[axis]! + CLEAR));
        down = Math.max(down, ...hits.map((h) => box.max[axis]! - h.bounds.min[axis]! + CLEAR));
        hitNames.push(...hits.map((h) => `"${h.with}"`));
      }
      const move = up <= down ? up : -down;
      const total = (movedSoFar.get(st.line) ?? 0) + Math.abs(move);
      if (total > MAX_MOVE) continue;
      movedSoFar.set(st.line, total);
      for (const member of set) {
        if (member.placement.kind === "beside") member.placement = { ...member.placement, shift: round(member.placement.shift + move) };
      }
      done.add(st.line);
      repairs.push({
        step: set.map((m) => m.id).join("+"),
        line: st.line,
        moved: round(Math.abs(move)),
        direction: axis === 1 ? (move > 0 ? "north" : "south") : move > 0 ? "east" : "west",
        because: `${set.length > 1 ? "together, to keep their spacing; " : ""}the box cut ${[...new Set(hitNames)].join(", ")}`,
      });
      changed = true;
    }
    current = { ...current, steps };
    if (!changed) break;
  }

  const plan = resolve(current);
  const unresolved = await findCollisions(client, plan, summary);
  for (const c of unresolved) {
    plan.errors.push(
      `${c.step} collides with "${c.with}" (${c.path.join(" > ")}), overlap ${c.overlap.join(" x ")} m, and sliding it up to ${MAX_MOVE} m along its wall doesn't clear it: change the brief`,
    );
  }
  return { draft: current, plan, repairs, unresolved };
}

/**
 * The resolver warns when a new block's box overlaps an existing item's OUTER box ("boxes only: check the
 * screenshot"). Once the real parts have been checked and none collide, those warnings are noise, so they
 * are replaced by one plain note.
 */
function dropBoxOnlyWarnings(plan: Plan): Plan {
  for (const a of plan.actions) {
    if (!a.builds) continue;
    const boxOnly = a.warnings.filter((w) => /its box overlaps R\d+/.test(w));
    if (boxOnly.length === 0) continue;
    a.warnings = a.warnings.filter((w) => !boxOnly.includes(w));
    a.details.push(`checked against the real parts: no collision (${boxOnly.map((w) => w.match(/R\d+/)![0]).join(", ")} only overlap as outer boxes)`);
  }
  return plan;
}

export type Verification = { ok: boolean; lines: string[] };

/**
 * After a run: read everything back. `before` is the room summary taken before running.
 * Checks: each new block exists at its planned size (1 mm); only the items the plan took out changed;
 * nothing else in the room moved, appeared or disappeared.
 */
export async function verifyRun(
  client: BridgeClient,
  plan: Plan,
  before: RoomSummary,
  after: RoomSummary,
  built: Record<string, number>, // step id -> entityId (from executePlan)
): Promise<Verification> {
  const lines: string[] = [];
  let ok = true;

  for (const a of plan.actions.filter((x) => x.builds && x.box)) {
    const want = a.box!;
    const id = built[a.builds!];
    const got = id === undefined ? null : await client.call("inspectEntity", { target: { entityId: id }, maxChildren: 0 });
    if (!got || !got.ok) {
      ok = false;
      lines.push(`MISSING ${a.builds}: not found after the run`);
      continue;
    }
    const err = Math.max(...[0, 1, 2].flatMap((i) => [Math.abs(got.data.worldBounds.min[i]! - want.min[i]!), Math.abs(got.data.worldBounds.max[i]! - want.max[i]!)]));
    if (err > 0.001) {
      ok = false;
      lines.push(`WRONG ${a.builds}: off by ${(err * 1000).toFixed(1)} mm`);
    } else lines.push(`ok ${a.builds}: in place, within ${(err * 1000).toFixed(1)} mm`);
  }

  const taken = new Set(
    plan.actions.filter((a) => a.tool === "moveToReplaced").map((a) => (a.args.target as { persistentId: number }).persistentId),
  );
  const afterById = new Map(after.items.map((it) => [it.persistentId, it]));
  for (const it of before.items) {
    const now = afterById.get(it.persistentId);
    if (!now) {
      ok = false;
      lines.push(`GONE ${it.ref} "${it.name}": it is no longer in the room`);
    } else if (taken.has(it.persistentId)) {
      if (!/^zz_REPLACED/.test(now.tag)) {
        ok = false;
        lines.push(`NOT REPLACED ${it.ref}: still on "${now.tag}"`);
      } else lines.push(`ok ${it.ref} taken out: now on "${now.tag}", not deleted`);
    } else if (now.tag !== it.tag || JSON.stringify(now.bounds) !== JSON.stringify(it.bounds)) {
      ok = false;
      lines.push(`CHANGED ${it.ref} "${it.name}": the plan didn't touch it, but its tag or box changed`);
    }
  }
  for (const it of after.items) {
    if (!before.items.some((b) => b.persistentId === it.persistentId)) {
      ok = false;
      lines.push(`NEW in the room: "${it.name}" (new blocks belong in their own group, not here)`);
    }
  }
  if (ok) lines.push(`ok: nothing else in the room changed (${before.items.length - taken.size} items unchanged)`);
  return { ok, lines };
}

/** A readable name: its own, or "<parent> part" for an unnamed or bare-number piece ("1069" tells you nothing). */
const label = (m: Found) => {
  const own = m.name || m.definitionName;
  return !own || /^\d+$/.test(own) || /^(group|component)#\d+$/i.test(own) ? `${m.path.at(-2) ?? "?"} part` : own;
};
const round = (v: number) => Math.round(v * 1000) / 1000;
