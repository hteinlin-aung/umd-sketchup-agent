import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { Draft, type DraftStep } from "../../src/agent/draft";
import { executePlan } from "../../src/agent/execute";
import { resolveDraft } from "../../src/agent/resolve";
import { BridgeClient } from "../../src/bridge/client";
import { MockSketchUp } from "../../src/bridge/mockSketchUp";
import type { Bounds } from "../../src/protocol/tools";
import { parseBrief } from "../../src/agent/brief";
import { briefRules } from "../../src/agent/planner";
import { checkAndRepair, faceIsCut, findCollisions, isShell, verifyRun } from "../../src/geometry/checks";
import { summarizeRoom } from "../../src/summary/roomSummary";
import { runOutcome } from "../../src/agent/outcome";

// MOCK: Week 3 geometry checks on the fake reception room (real positions, simplified parts).

const ROOM = "1F RECEPTION - TERRARIUMS + LOUNGE (T128, per revised plan)";
const REF = Draft.parse(JSON.parse(readFileSync("instructions/1F_reception.draft.json", "utf8")));
const OPTS = { runId: "chk", briefName: "1F_reception" };

const setup = async () => {
  const sketchup = new MockSketchUp({ scene: "reception" });
  const client = new BridgeClient(sketchup);
  const summary = await summarizeRoom(client, { path: [ROOM] });
  const room = sketchup.allEntities().find((e) => e.name === ROOM)!;
  const resolve = (d: Draft) => resolveDraft(d, summary, OPTS);
  return { sketchup, client, summary, room, resolve };
};

/** A column (just faces, no parts) dropped into the room, like the ones Terrarium A wraps. */
const column = (sketchup: MockSketchUp, roomId: number, x0: number, y0: number, x1: number, y1: number, name = "column C7") =>
  sketchup.addEntity({ type: "Group", name, tag: "Layer0", parentId: roomId, bounds: { min: [x0, y0, 1.489], max: [x1, y1, 4.99] } });

// Windows, 2026-11-13 (brief 5 in T133): the check only looked inside the room group, so it never saw the timber
// screen, the platforms or the walls - and those walls are raw geometry whose ONE box covers a whole room.
describe("shells: a box too big to be a part", () => {
  const block = { min: [34.6, 72.74, 1.489], max: [35.05, 75.74, 1.939] } as Bounds;

  it("the 1F walls group (its box covers the whole breathing room) is a shell, a slat and a column are not", () => {
    expect(isShell({ min: [14.33, 68.99, 1.49], max: [34.88, 79.34, 5.41] }, block)).toBe(true); // Group#276
    expect(isShell({ min: [34.95, 69.38, 1.49], max: [35.25, 69.42, 5.31] }, block)).toBe(false); // a B2 slat
    expect(isShell({ min: [33.84, 79.48, 1.06], max: [34.34, 79.98, 5.3] }, block)).toBe(false); // a column
    expect(isShell({ min: [0.53, 68.01, 1.49], max: [147.14, 113.09, 1.49] }, block)).toBe(true); // the flat floor plate
  });

  it("standing on a floor face or against a wall face is not a collision; crossing one is", () => {
    const floor = { min: [0, 0, 1.489], max: [50, 100, 1.489] } as Bounds;
    expect(faceIsCut(block, floor)).toBe(false); // the bench stands on it
    const wall = { min: [34.6, 60, 1.49], max: [34.6, 80, 5] } as Bounds;
    expect(faceIsCut(block, wall)).toBe(false); // the bench's west side touches it
    const through = { min: [34.8, 60, 1.49], max: [34.8, 80, 5] } as Bounds;
    expect(faceIsCut(block, through)).toBe(true); // the bench crosses this one
    const buried = { min: [0, 0, 1.7], max: [50, 100, 1.7] } as Bounds;
    expect(faceIsCut(block, buried)).toBe(true); // a floor face through the middle of the bench
  });
});

describe("collision checks against the real parts", () => {
  /** A shell like "1F Walls & partitions > Group#276": one huge box, with faces where the material really is. */
  const shell = (sketchup: MockSketchUp, faces: Bounds[]) =>
    sketchup.addEntity({
      type: "Group",
      name: "1F walls (raw geometry)",
      tag: "Layer0",
      parentId: null,
      bounds: { min: [70, 84, 1.489], max: [103, 111, 5.41] },
      faces: faces.map((b) => ({ normal: [0, 0, 1] as [number, number, number], material: null, backMaterial: null, bounds: b })),
    });

  it("a shell's own box never collides: its faces decide (brief 1 still passes)", async () => {
    const { client, summary, sketchup, resolve } = await setup();
    shell(sketchup, [{ min: [70, 84, 1.489], max: [103, 111, 1.489] }]); // just a floor face, under everything
    expect(await findCollisions(client, resolve(REF), summary)).toEqual([]);
  });

  it("a face the block really crosses is a collision, named with the shell", async () => {
    const { client, summary, sketchup, resolve } = await setup();
    const plan = resolve(REF);
    const box = plan.actions.find((a) => a.builds === "S1")!.box!;
    const mid = (i: number) => (box.min[i]! + box.max[i]!) / 2;
    shell(sketchup, [{ min: [mid(0), 84, mid(2)], max: [mid(0), 111, mid(2)] }]); // a plane through the counter
    const hits = await findCollisions(client, plan, summary);
    expect(hits.map((h) => h.step)).toEqual(["S1"]);
    expect(hits[0]!.with).toMatch(/1F walls \(raw geometry\) \(1 face\)/);
  });

  it("a shell that can't be read fully is an error, never 'clear'", async () => {
    const { client, summary, sketchup, resolve } = await setup();
    const plan = resolve(REF);
    const box = plan.actions.find((a) => a.builds === "S1")!.box!;
    const one = { min: [box.min[0]!, box.min[1]!, box.min[2]!], max: [box.max[0]!, box.max[1]!, box.max[2]!] } as Bounds;
    const many = shell(sketchup, Array.from({ length: 3 }, () => one));
    expect(many.faces.length).toBe(3);
    const limited = {
      call: async (tool: string, args: Record<string, unknown>) =>
        tool === "facesInBox" ? client.call("facesInBox", { ...args, limit: 1 } as never) : client.call(tool as never, args as never),
    } as unknown as BridgeClient;
    await expect(findCollisions(limited, plan, summary)).rejects.toThrow(/was NOT checked/);
  });

  it("brief 1's reference plan cuts into nothing", async () => {
    const { client, summary, resolve } = await setup();
    expect(await findCollisions(client, resolve(REF), summary)).toEqual([]);
  });

  // Windows, 2026-11-13: a search that stopped at the bridge's scan limit returned no matches, and the check said
  // "no new block cuts into any real part" while the bench stood in the B2 timber screen.
  it("a search that hit the scan limit is an error, never 'no collision'", async () => {
    const { client, summary, resolve } = await setup();
    const limited = {
      call: async (tool: string, args: unknown) =>
        tool === "findEntities" ? { ok: true, data: { matches: [], truncated: false, scanned: 30000, scanLimitHit: true } } : client.call(tool as never, args as never),
    } as unknown as BridgeClient;
    await expect(findCollisions(limited, resolve(REF), summary)).rejects.toThrow(/too big to search completely/);
  });

  it("drops the 'outer boxes overlap' warning when no real part collides (bench vs Lounge bay)", async () => {
    const { client, summary, resolve } = await setup();
    const { plan } = await checkAndRepair(client, REF, summary, resolve);
    const bench = plan.actions.find((a) => a.builds === "S3")!;
    expect(bench.warnings).toEqual([]);
    expect(bench.details.at(-1)).toMatch(/no collision \(R10 only overlap as outer boxes\)/);
  });

  it("WEEK 3 DONE-WHEN: a counter over a column is caught and slid clear, and its top moves with it", async () => {
    const { sketchup, client, summary, room, resolve } = await setup();
    column(sketchup, room.entityId, 91.4, 101.0, 91.8, 101.4); // inside the counter's footprint
    const { plan, repairs, unresolved } = await checkAndRepair(client, REF, summary, resolve);
    expect(unresolved).toEqual([]);
    expect(repairs).toEqual([{ step: "S1", line: 2, moved: 0.68, direction: "north", because: 'the box cut "column C7"' }]);
    expect(plan.errors).toEqual([]);
    const ys = (id: string) => (plan.actions.find((a) => a.builds === id)!.args.points as number[][]).map((p) => p[1]!);
    expect(Math.min(...ys("S1"))).toBeCloseTo(101.45, 6); // 5 cm clear of the column
    expect(Math.min(...ys("S2"))).toBeCloseTo(101.4, 6); // the top followed (0.05 overhang)
    expect(await findCollisions(client, plan, summary)).toEqual([]);
  });

  it("moves a PAIR together, so the 1.8 m path between the entrance kerbs is kept (Windows, 2026-11-12)", async () => {
    const { sketchup, client, summary, room, resolve } = await setup();
    // Like the real olive armchair: it reaches into the north kerb only.
    sketchup.addEntity({ type: "Group", name: "olive armchair (3DW Pietra)", tag: "Layer0", parentId: room.entityId, bounds: { min: [97.5, 104.2, 1.489], max: [98.3, 105.0, 2.3] } });
    const brief = parseBrief(readFileSync("instructions/1F_reception.md", "utf8"));
    const { plan, repairs } = await checkAndRepair(client, REF, summary, resolve, briefRules(brief));
    expect(repairs).toHaveLength(1);
    expect(repairs[0]).toMatchObject({ step: "S4+S5", line: 5, direction: "south" });
    expect(repairs[0]!.because).toMatch(/^together, to keep their spacing/);
    expect(plan.errors).toEqual([]);
    expect(briefRules(brief)(plan)).toEqual([]); // still exactly 1.8 m clear
  });

  it("stops the plan when an automatic move would break one of the brief's rules", async () => {
    const { sketchup, client, summary, room, resolve } = await setup();
    column(sketchup, room.entityId, 91.4, 101.0, 91.8, 101.4);
    const { plan } = await checkAndRepair(client, REF, summary, resolve, () => ["change 2 wants the counter centred on Terrarium A"]);
    expect(plan.errors.join()).toMatch(/the automatic move broke the brief: change 2 wants the counter centred.*Nothing was changed/);
  });

  it("names a bare-number part after the group it belongs to ('1069' tells you nothing)", async () => {
    const { sketchup, client, summary, room, resolve } = await setup();
    const chair = sketchup.addEntity({ type: "Group", name: "olive armchair (3DW Pietra)", tag: "Layer0", parentId: room.entityId, bounds: { min: [91.4, 101, 1.489], max: [91.8, 101.4, 2.3] } });
    sketchup.addEntity({ type: "Group", name: "1069", tag: "Layer0", parentId: chair.entityId, bounds: chair.bounds });
    const hits = await findCollisions(client, resolve(REF), summary);
    expect(hits.map((h) => h.with)).toEqual(["olive armchair (3DW Pietra) part"]);
  });

  it("reports honestly when sliding up to 2 m can't clear it, and the plan can't run", async () => {
    const { sketchup, client, summary, room, resolve } = await setup();
    column(sketchup, room.entityId, 91.3, 98.0, 91.7, 107.0, "partition wall P2"); // longer than the counter can slide past
    const { plan, unresolved } = await checkAndRepair(client, REF, summary, resolve);
    expect(unresolved.map((c) => c.with)).toContain("partition wall P2");
    expect(plan.errors.join()).toMatch(/S1 collides with "partition wall P2".*doesn't clear it: change the brief/);
    await expect(executePlan(client, plan)).rejects.toThrow(/errors/);
  });

  it("doesn't count an item the plan takes out first (building where Sofa set 4 stood)", async () => {
    const { client, summary, resolve } = await setup();
    // Sofa set 4 sits at x 84.502..85.454; a block beside R3 (Terrarium B2) north, gap 11.4, lands on it.
    const block: DraftStep = { op: "build", line: 2, id: "S1", name: "plinth", placement: { kind: "beside", anchor: "R3", side: "north", gap: 11.4, eastWest: 0.6, northSouth: 0.6, shift: 0.5 }, height: 0.3, base: 0, tag: "T" };
    const save: DraftStep = { op: "save", line: 8, fileName: "x.skp" };
    const without = await findCollisions(client, resolve({ steps: [block, save], notDone: [] }), summary);
    expect(without.map((c) => c.with)[0]).toMatch(/parlor palm/);
    const withReplace = await findCollisions(client, resolve({ steps: [{ op: "replace", line: 1, target: "R5" }, block, save], notDone: [] }), summary);
    expect(withReplace).toEqual([]);
  });

  it("ignores parts on hidden tags", async () => {
    const { sketchup, client, summary, room, resolve } = await setup();
    sketchup.tags.set("zz_old", false);
    sketchup.addEntity({ type: "Group", name: "old desk", tag: "zz_old", parentId: room.entityId, bounds: { min: [91.4, 101, 1.489], max: [91.8, 101.4, 2.5] } });
    expect(await findCollisions(client, resolve(REF), { ...summary, tags: [...summary.tags, { name: "zz_old", visible: false }] })).toEqual([]);
  });
});

describe("read-back after the run (verifyRun)", () => {
  it("confirms every block in place and nothing else in the room changed", async () => {
    const { client, summary, resolve } = await setup();
    const plan = resolve(REF);
    let verdict: string[] = [];
    const run = await executePlan(client, plan, () => {}, async (built) => {
      const v = await verifyRun(client, plan, summary, await summarizeRoom(client, { path: [ROOM] }), built);
      verdict = v.lines;
      return v.ok;
    });
    expect(run.savedPath).not.toBeNull();
    expect(verdict.filter((l) => !l.startsWith("ok"))).toEqual([]);
    expect(verdict.at(-1)).toBe("ok: nothing else in the room changed (11 items unchanged)");
  });

  it("refuses to save when something the plan didn't touch has changed", async () => {
    const { sketchup, client, summary, resolve } = await setup();
    const plan = resolve(REF);
    const run = await executePlan(client, plan, () => {}, async (built) => {
      const terrC = sketchup.allEntities().find((e) => e.name.startsWith("Terrarium C"))!;
      terrC.tag = "1F Reception - Furniture (T128)"; // something outside the plan changed
      const v = await verifyRun(client, plan, summary, await summarizeRoom(client, { path: [ROOM] }), built);
      expect(v.lines.join()).toMatch(/CHANGED R4 "Terrarium C/);
      return v.ok;
    });
    expect(run.savedPath).toBeNull();
    expect(run.results.at(-1)!.message).toMatch(/not saved: the read-back check failed/);
  });

  it("reports a block that isn't there any more", async () => {
    const { client, summary, resolve } = await setup();
    const plan = resolve(REF);
    const v = await verifyRun(client, plan, summary, summary, { S1: 999999 });
    expect(v.ok).toBe(false);
    expect(v.lines[0]).toBe("MISSING S1: not found after the run");
  });
});

// Week 3 DONE-WHEN (test brief 6, instructions/1F_reception_wrong.md): one deliberately wrong change, one good one,
// and ONE clear outcome. The real reception stands on a 5 m grid of D500 columns that are not in the room summary;
// these are their real positions (Windows, 2026-11-13).
describe("test brief 6: the Week 3 done-when", () => {
  const wrong = Draft.parse(JSON.parse(readFileSync("instructions/1F_reception_wrong.draft.json", "utf8")));
  const blocked = Draft.parse(JSON.parse(readFileSync("instructions/1F_reception_wrong.blocked.draft.json", "utf8")));
  const withColumns = async () => {
    const s = await setup();
    column(s.sketchup, s.room.entityId, 93.89, 99.49, 94.39, 99.99, "UMD Column D500 1F colonnade");
    column(s.sketchup, s.room.entityId, 93.89, 104.49, 94.39, 104.99, "UMD Column D500 1F colonnade");
    return s;
  };

  it("the plinth on the column is caught and slid 0.87 m north; the window bench is untouched; SUCCESS after running", async () => {
    const { client, summary, resolve } = await withColumns();
    const before = resolve(wrong).actions.find((a) => a.builds === "S2")!.box;
    const checked = await checkAndRepair(client, wrong, summary, resolve);
    expect(checked.plan.errors).toEqual([]);
    expect(checked.repairs.map((r) => [r.step, r.moved, r.direction])).toEqual([["S1", 0.87, "north"]]);
    expect(checked.repairs[0]!.because).toMatch(/UMD Column D500 1F colonnade/);
    expect(checked.plan.actions.find((a) => a.builds === "S2")!.box).toEqual(before);
    const run = await executePlan(client, checked.plan);
    const o = runOutcome({ planErrors: [], repairsExhausted: checked.exhausted, moved: ["S1 0.87 m north (brief line 1)"], modelGaveUp: [], dry: false, declined: false, run });
    expect(o.outcome).toBe("SUCCESS");
    expect(o.why.join()).toMatch(/moved automatically \(you approved it\): S1 0\.87 m north/);
  });

  it("6 m long, through two columns: no slide of 2 m or less clears it, so it is reported and NOTHING runs - BLOCKED", async () => {
    const { client, summary, resolve } = await withColumns();
    const checked = await checkAndRepair(client, blocked, summary, resolve);
    expect(checked.repairs).toEqual([]);
    expect(checked.unresolved.map((c) => c.step)).toEqual(["S1", "S1"]);
    expect(checked.exhausted).toBe(false);
    expect(checked.plan.errors.join()).toMatch(/S1 collides with 2x "UMD Column D500 1F colonnade".*change the brief/);
    const o = runOutcome({ planErrors: checked.plan.errors, repairsExhausted: checked.exhausted, moved: [], modelGaveUp: [], dry: false, declined: false, run: null });
    expect(o.outcome).toBe("BLOCKED");
    await expect(executePlan(client, checked.plan)).rejects.toThrow(/errors/);
  });

  it("a block that bounces between two obstacles uses all 3 tries and still collides: MAX_ATTEMPTS_REACHED", async () => {
    const { client, summary, sketchup, room, resolve } = await setup();
    const one: Draft = { steps: [wrong.steps[0]!, { op: "save", line: 5, fileName: "x.skp" }], notDone: [] };
    const box = resolve(one).actions.find((a) => a.builds === "S1")!.box!;
    const [x0, x1, y0, y1] = [box.min[0]!, box.max[0]!, box.min[1]!, box.max[1]!];
    column(sketchup, room.entityId, x0, y1 - 0.1, x1, y1, "bar A"); // overlaps its north end by 0.1: slides 0.15 south ...
    column(sketchup, room.entityId, x0, y0 - 0.15, x1, y0 - 0.05, "bar B"); // ... onto bar B: slides 0.15 north, onto bar A ...
    const checked = await checkAndRepair(client, one, summary, resolve);
    expect(checked.repairs).toHaveLength(3);
    expect(checked.exhausted).toBe(true);
    const o = runOutcome({ planErrors: checked.plan.errors, repairsExhausted: checked.exhausted, moved: [], modelGaveUp: [], dry: false, declined: false, run: null });
    expect(o.outcome).toBe("MAX_ATTEMPTS_REACHED");
    expect(o.why[0]).toMatch(/all 3 of its tries/);
  });
});

describe("runOutcome: one clear outcome for every way a run can end", () => {
  it("says what was NOT checked, even on SUCCESS", () => {
    const o = runOutcome({ planErrors: [], repairsExhausted: false, moved: [], modelGaveUp: [], notChecked: ["walls and columns (no building in this model)"], dry: false, declined: false, run: { results: [], stoppedAt: null, savedPath: "x.skp", imagePath: null, imagePaths: [], built: {} } });
    expect(o.why.join()).toMatch(/NOT CHECKED: walls and columns/);
  });
  const run = (stoppedAt: number | null) => ({
    results: [{ n: 1, ok: stoppedAt === null, message: stoppedAt === null ? "ok" : "VERIFY_FAILED: measured size is wrong", durationMs: 1 }],
    stoppedAt, savedPath: stoppedAt === null ? "E:/x.skp" : null, imagePath: null, imagePaths: [], built: {},
  });
  const base = { planErrors: [] as string[], repairsExhausted: false, moved: [] as string[], modelGaveUp: [] as { line: number; reason: string }[], dry: false, declined: false };
  it.each([
    ["all ran", { ...base, run: run(null) }, "SUCCESS"],
    ["plan errors", { ...base, planErrors: ["S1 collides with ..."], run: null }, "BLOCKED"],
    ["repair gave up", { ...base, planErrors: ["S1 collides with ..."], repairsExhausted: true, run: null }, "MAX_ATTEMPTS_REACHED"],
    ["you typed n", { ...base, declined: true, run: null }, "BLOCKED"],
    ["a step failed in SketchUp", { ...base, run: run(1) }, "BLOCKED"],
    ["the model couldn't plan a change; the rest ran", { ...base, modelGaveUp: [{ line: 2, reason: "S1 ends up outside the room" }], run: run(null) }, "MAX_ATTEMPTS_REACHED"],
    ["--dry", { ...base, dry: true, run: null }, "NOT RUN"],
    ["ran, but the model had no building to check against", { ...base, notChecked: ["no floor under the room"], run: run(null) }, "SUCCESS"],
  ] as const)("%s -> %s", (_n, input, want) => {
    expect(runOutcome(input as never).outcome).toBe(want);
  });
});
