import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { Draft, type DraftStep } from "../../src/agent/draft";
import { executePlan } from "../../src/agent/execute";
import { resolveDraft } from "../../src/agent/resolve";
import { BridgeClient } from "../../src/bridge/client";
import { MockSketchUp } from "../../src/bridge/mockSketchUp";
import { parseBrief } from "../../src/agent/brief";
import { briefRules } from "../../src/agent/planner";
import { checkAndRepair, findCollisions, verifyRun } from "../../src/geometry/checks";
import { summarizeRoom } from "../../src/summary/roomSummary";

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

describe("collision checks against the real parts", () => {
  it("brief 1's reference plan cuts into nothing", async () => {
    const { client, summary, resolve } = await setup();
    expect(await findCollisions(client, resolve(REF), summary)).toEqual([]);
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
