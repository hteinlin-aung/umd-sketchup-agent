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
const CLEAR = 0.05; // a repaired block keeps 5 cm from what it hit
const MAX_TRIES = 3;
const MAX_MOVE = 2.0; // further than this changes the design: report instead

const shrink = (b: Bounds, d: number): Bounds => ({
  min: b.min.map((v) => v + d) as Bounds["min"],
  max: b.max.map((v) => v - d) as Bounds["max"],
});

function boxOfAction(args: Record<string, unknown>): Bounds {
  const pts = args.points as [number, number][];
  return {
    min: [Math.min(...pts.map((p) => p[0])), Math.min(...pts.map((p) => p[1])), args.z0 as number],
    max: [Math.max(...pts.map((p) => p[0])), Math.max(...pts.map((p) => p[1])), args.z1 as number],
  };
}

const isPrefix = (a: string[], b: string[]) => a.length < b.length && a.every((n, i) => n === b[i]);

/** The real parts each new block of the plan would cut into. Read-only. */
export async function findCollisions(client: BridgeClient, plan: Plan, summary: RoomSummary): Promise<Collision[]> {
  const room = { persistentId: summary.room.persistentId };
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
    if (a.tool !== "createPrism" || !a.builds) continue;
    const box = boxOfAction(a.args);
    const res = await client.call("findEntities", { within: room, touches: shrink(box, TOUCH), maxDepth: 6, limit: 500 });
    if (!res.ok) throw new Error(`collision check failed: ${res.error.code}: ${res.error.message}`);

    const live = res.data.matches.filter(
      (m) => !m.hidden && !hiddenTags.has(m.tag) && !removed.some((p) => p.join("\u0000") === m.path.join("\u0000") || isPrefix(p, m.path)),
    );
    // Only real parts count: things with no smaller parts inside (just faces), or the deepest level searched.
    // A group whose outer box overlaps while none of its parts do is empty space (the Lounge bay's box
    // reaches the bench, its sofas don't).
    if (res.data.truncated) throw new Error(`collision check for ${a.builds}: too many parts in its box to check them all`);
    const leaves = live.filter((m) => m.childCount === 0 || m.depth >= 6);
    for (const m of leaves) {
      const overlap = [0, 1, 2].map((i) => Math.min(box.max[i]!, m.bounds.max[i]!) - Math.max(box.min[i]!, m.bounds.min[i]!)) as [number, number, number];
      if (overlap.every((v) => v > TOUCH)) out.push({ step: a.builds, with: label(m), path: m.path, bounds: m.bounds, overlap: overlap.map(round) as [number, number, number] });
    }
  }
  return out;
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
): Promise<CheckResult> {
  let current = draft;
  const repairs: Repair[] = [];
  const movedSoFar = new Map<string, number>();

  for (let attempt = 1; attempt <= MAX_TRIES; attempt++) {
    const plan = resolve(current);
    const collisions = await findCollisions(client, plan, summary);
    if (collisions.length === 0) return { draft: current, plan: dropBoxOnlyWarnings(plan), repairs, unresolved: [] };

    let changed = false;
    const steps = current.steps.map((st) => ({ ...st })) as DraftStep[];
    for (const step of new Set(collisions.map((c) => c.step))) {
      const st = steps.find((s) => s.op === "build" && s.id === step) as Extract<DraftStep, { op: "build" }> | undefined;
      if (!st || st.placement.kind !== "beside") continue; // a top moves with its base
      const action = plan.actions.find((a) => a.builds === step)!;
      const box = boxOfAction(action.args);
      const axis = st.placement.side === "east" || st.placement.side === "west" ? 1 : 0; // slide along the wall
      const hits = collisions.filter((c) => c.step === step);
      const obstacles = hits.map((h) => h.bounds);
      const up = Math.max(...obstacles.map((o) => o.max[axis]! - box.min[axis]!)) + CLEAR;
      const down = Math.max(...obstacles.map((o) => box.max[axis]! - o.min[axis]!)) + CLEAR;
      const move = up <= down ? up : -down;
      const total = (movedSoFar.get(step) ?? 0) + Math.abs(move);
      if (total > MAX_MOVE) continue;
      movedSoFar.set(step, total);
      st.placement = { ...st.placement, shift: round(st.placement.shift + move) };
      repairs.push({
        step,
        line: st.line,
        moved: round(Math.abs(move)),
        direction: axis === 1 ? (move > 0 ? "north" : "south") : move > 0 ? "east" : "west",
        because: `its box cut ${hits.map((h) => `"${h.with}"`).join(", ")}`,
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

  for (const a of plan.actions.filter((x) => x.tool === "createPrism" && x.builds)) {
    const want = boxOfAction(a.args);
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

/** A readable name: its own, or "<parent> part" for an unnamed piece. */
const label = (m: Found) => m.name || (/^(group|component)#\d+$/i.test(m.definitionName) ? `${m.path.at(-2) ?? "?"} part` : m.definitionName);
const round = (v: number) => Math.round(v * 1000) / 1000;
