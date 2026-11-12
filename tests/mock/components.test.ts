import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { scorePlan } from "../../src/agent/bench";
import { loadCatalog, plausibility, renderCatalog, turnedSize } from "../../src/agent/catalog";
import type { DraftStep } from "../../src/agent/draft";
import { executePlan } from "../../src/agent/execute";
import { checkAnswer } from "../../src/agent/planner";
import { resolveDraft } from "../../src/agent/resolve";
import { BridgeClient } from "../../src/bridge/client";
import { MockSketchUp } from "../../src/bridge/mockSketchUp";
import { checkAndRepair, verifyRun } from "../../src/geometry/checks";
import { summarizeRoom } from "../../src/summary/roomSummary";

// MOCK: Week 3 components (listComponents / componentInfo / placeComponent) on the fake room and folder.

const ROOM = "1F RECEPTION - TERRARIUMS + LOUNGE (T128, per revised plan)";
const TAG = "1F Reception - Plants (AGENT)";
const cache = () => join(mkdtempSync(join(tmpdir(), "umd-cat-")), "components.json");

const setup = async () => {
  const sketchup = new MockSketchUp({ scene: "reception" });
  const client = new BridgeClient(sketchup);
  const summary = await summarizeRoom(client, { path: [ROOM] });
  const { catalog } = await loadCatalog(client, { cachePath: cache() });
  const opts = { runId: "cmp", briefName: "plants", catalog };
  return { sketchup, client, summary, catalog, opts };
};

const moneyTree: DraftStep = {
  op: "place", line: 1, id: "S1", component: "3DW_Money tree potted.skp", name: "Money tree",
  placement: { kind: "beside", anchor: "R8", side: "east", gap: 0.3, shift: 3 }, rotation: 0, base: 0, tag: TAG,
};
const save: DraftStep = { op: "save", line: 4, fileName: "plants.skp" };

describe("the components catalog", () => {
  it("measures every file once, caches it, and only measures new or changed files after that", async () => {
    const sketchup = new MockSketchUp({ scene: "reception" });
    const client = new BridgeClient(sketchup);
    const path = cache();
    const first = await loadCatalog(client, { cachePath: path });
    expect(first.catalog.get("3DW_Money tree potted.skp")!.size).toEqual([0.6, 0.6, 1.6]);
    const measuredFirst = sketchup.received.filter((c) => c.tool === "componentInfo").length;
    expect(measuredFirst).toBe(5);

    sketchup.components.set("3DW_Fittonia.skp", { bytes: 300_000, size: [0.3, 0.3, 0.25] });
    await loadCatalog(client, { cachePath: path });
    const measuredAgain = sketchup.received.filter((c) => c.tool === "componentInfo").map((c) => c.args.file);
    expect(measuredAgain.slice(measuredFirst)).toEqual(["3DW_Fittonia.skp", "3DW_Huge test model.skp"]); // new + the one that failed
    expect(JSON.parse(readFileSync(path, "utf8"))).toHaveLength(5);
  });

  it("reports a file over the size limit instead of loading it", async () => {
    const { problems } = await loadCatalog(new BridgeClient(new MockSketchUp({ scene: "reception" })), { cachePath: cache() });
    expect(problems).toEqual(['3DW_Huge test model.skp: INVALID_ARGS: "3DW_Huge test model.skp" is 61 MB; the limit is 50 MB']);
  });

  it("on the MASTER (can't measure) uses only the cache and says what's missing", async () => {
    const { problems, catalog } = await loadCatalog(new BridgeClient(new MockSketchUp({ scene: "reception" })), { cachePath: cache(), canMeasure: false });
    expect(catalog.size).toBe(0);
    expect(problems[0]).toMatch(/not measured yet .*npm run components/);
  });

  it("lists the components for the model, and turning 90° swaps east-west and north-south", async () => {
    const { catalog } = await setup();
    expect(renderCatalog(catalog)).toContain("- 3DW_Mercy S curved boucle sofa.skp: 1.7 x 3 x 0.62");
    expect(turnedSize([1.7, 3, 0.62], 90)).toEqual([3, 1.7, 0.62]);
    expect(turnedSize([1.7, 3, 0.62], 180)).toEqual([1.7, 3, 0.62]);
  });
});

describe("does the size match the name? (real sizes from Windows, 2026-11-12)", () => {
  it.each<[string, [number, number, number], RegExp]>([
    ["3DW_coffee_table_marble_round.skp", [3.955, 3.915, 2.636], /a coffee table 2\.64 m tall/],
    ["3DW_easel_white_canvas.skp", [2.93, 3.6, 1.77], /an easel 3\.60 m across/],
    ["ZEN+GARDEN3DW_zen_garden_Finkong.skp", [54.75, 5.73, 1.42], /zen garden or rocks 54\.75 m across/],
    ["3DW_zen_garden_MarkE.skp", [16.3, 8.14, 5.36], /zen garden or rocks 5\.36 m tall/],
    ["3DW_banyan_tree_3D_MananC.skp", [24, 24, 15], /24\.00 m across: too big for an interior/],
  ])("flags %s", (file, size, why) => {
    expect(plausibility(file, size)).toMatch(why);
  });

  it.each<[string, [number, number, number]]>([
    ["3DW_money_tree_Pachira_VitorB_86654.skp", [1.1, 1.0, 1.778]],
    ["3DW_Mercy S curved boucle sofa.skp", [1.7, 3.0, 0.62]],
    ["3DW_Waltz chair.skp", [0.6, 0.65, 0.8]],
    ["3DW_hands_sculpture.skp", [1.2, 1.2, 2.2]],
  ])("accepts %s", (file, size) => {
    expect(plausibility(file, size)).toBeNull();
  });

  it("tells the model not to use a mis-scaled one, and the plan refuses it", async () => {
    const { sketchup, client, summary } = await setup();
    sketchup.components.set("3DW_coffee_table_marble_round.skp", { bytes: 500_000, size: [3.955, 3.915, 2.636] });
    const { catalog } = await loadCatalog(client, { cachePath: cache() });
    expect(renderCatalog(catalog)).toMatch(/3DW_coffee_table_marble_round\.skp: 3\.96 x 3\.92 x 2\.64 {2}\(DO NOT USE: looks wrong, a coffee table/);
    const table = { ...moneyTree, component: "3DW_coffee_table_marble_round.skp" } as DraftStep;
    const errors = resolveDraft({ steps: [table, save], notDone: [] }, summary, { runId: "x", briefName: "p", catalog }).errors;
    expect(errors[0]).toMatch(/looks wrong: a coffee table 2\.64 m tall.*Pick another component, or fix the file's scale in SketchUp/);
  });

  it("refuses a component that would go through the ceiling (the 4.6 m banyan in a 3.5 m room)", async () => {
    const { summary, opts } = await setup();
    const banyan = { ...moneyTree, component: "3DW_Banyan tree.skp" } as DraftStep;
    expect(resolveDraft({ steps: [banyan, save], notDone: [] }, summary, opts).errors[0]).toMatch(/4\.6 m tall and would go through the ceiling/);
  });

  it("shows each placed component's height against a door, so a wrong size is easy to see", async () => {
    const { summary, opts } = await setup();
    const a = resolveDraft({ steps: [moneyTree, save], notDone: [] }, summary, opts).actions[0]!;
    expect(a.details).toContain("0.6 m east-west, 0.6 m north-south, top 1.6 m above the floor (a door is about 2.1 m)");
  });
});

describe("placing components", () => {
  it("works out where the money tree goes from its real size, 0.3 m east of Terrarium E", async () => {
    const { summary, opts } = await setup();
    const plan = resolveDraft({ steps: [moneyTree, save], notDone: [] }, summary, opts);
    expect(plan.errors).toEqual([]);
    const a = plan.actions[0]!;
    expect(a.tool).toBe("placeComponent");
    // Terrarium E: x max 80.457, y 97.233..109.495 (centre 103.364); +3 north; tree 0.6 x 0.6
    expect(a.args).toMatchObject({ file: "3DW_Money tree potted.skp", at: [80.757, 106.064, 1.489], rotation: 0, tag: TAG });
    expect(a.box).toEqual({ min: [80.757, 106.064, 1.489], max: [81.357, 106.664, 3.089] });
  });

  it("turns the sofa 90° and uses its turned size", async () => {
    const { summary, opts } = await setup();
    const sofa: DraftStep = { ...moneyTree, component: "3DW_Mercy S curved boucle sofa.skp", rotation: 90 } as DraftStep;
    const a = resolveDraft({ steps: [sofa, save], notDone: [] }, summary, opts).actions[0]!;
    expect(a.box!.max[0] - a.box!.min[0]).toBeCloseTo(3, 6);
    expect(a.box!.max[1] - a.box!.min[1]).toBeCloseTo(1.7, 6);
  });

  it("accepts a name without .skp or in another case, and refuses one that isn't in the folder", async () => {
    const { summary, opts } = await setup();
    const loose = { ...moneyTree, component: "3dw_money tree potted" } as DraftStep;
    expect(resolveDraft({ steps: [loose, save], notDone: [] }, summary, opts).errors).toEqual([]);
    const missing = { ...moneyTree, component: "3DW_Chandelier.skp" } as DraftStep;
    expect(resolveDraft({ steps: [missing, save], notDone: [] }, summary, opts).errors[0]).toMatch(/"3DW_Chandelier.skp" is not in the components folder/);
  });

  it("places, reads back and saves on the fake room", async () => {
    const { sketchup, client, summary, opts } = await setup();
    const plan = resolveDraft({ steps: [moneyTree, save], notDone: [] }, summary, opts);
    let lines: string[] = [];
    const run = await executePlan(client, plan, () => {}, async (built) => {
      const v = await verifyRun(client, plan, summary, await summarizeRoom(client, { path: [ROOM] }), built);
      lines = v.lines;
      return v.ok;
    });
    expect(run.savedPath).not.toBeNull();
    expect(lines[0]).toBe("ok S1: in place, within 0.0 mm");
    expect(sketchup.allEntities().find((e) => e.name === "Money tree")).toMatchObject({ type: "ComponentInstance", tag: TAG });
  });

  it("checks a component against the real parts too, and slides it clear", async () => {
    const { sketchup, client, summary, opts } = await setup();
    const room = sketchup.allEntities().find((e) => e.name === ROOM)!;
    sketchup.addEntity({ type: "Group", name: "column C9", tag: "Layer0", parentId: room.entityId, bounds: { min: [80.9, 106.3, 1.489], max: [81.2, 106.6, 4.99] } });
    const { repairs, plan } = await checkAndRepair(client, { steps: [moneyTree, save], notDone: [] }, summary, (d) => resolveDraft(d, summary, opts));
    expect(repairs[0]).toMatchObject({ step: "S1", direction: "south" });
    expect(plan.errors).toEqual([]);
  });

  it("is refused by the bridge on the MASTER", async () => {
    const sketchup = new MockSketchUp({ scene: "reception", modelPath: "E:/x/Urban_Mind_Detox_MASTER.skp" });
    const res = await new BridgeClient(sketchup).call("placeComponent", { jobGroup: "J", file: "3DW_Money tree potted.skp", name: "t", tag: "T", at: [0, 0, 0] });
    expect(!res.ok && res.error.code).toBe("WRONG_MODEL");
  });

  it("scores a placed component by file, position and rotation in the benchmark", async () => {
    const { summary, opts } = await setup();
    const ref = resolveDraft({ steps: [moneyTree, save], notDone: [] }, summary, opts);
    const moved = resolveDraft({ steps: [{ ...moneyTree, placement: { ...(moneyTree as { placement: object }).placement, shift: 2 } } as DraftStep, save], notDone: [] }, summary, opts);
    expect(scorePlan(ref, ref, [1, 4]).right).toBe(2);
    expect(scorePlan(moved, ref, [1, 4]).right).toBe(1);
  });
});

describe("the planner and components", () => {
  const change = { line: 1, text: "Money tree. Place the potted money tree component 0.3 m east of Terrarium E, shifted 3.0 m north of its centre." };
  const answer = (steps: unknown[]) => JSON.stringify({ type: "steps", steps, reason: "" });
  const { line: _l, ...tree } = moneyTree;

  it("accepts a place step for a change that asks for a component", async () => {
    const { summary, opts } = await setup();
    expect(checkAnswer(answer([tree]), change, [], 1, summary, opts).problems).toEqual([]);
  });

  it("refuses a box drawn instead of the component", async () => {
    const { summary, opts } = await setup();
    const box = { op: "build", id: "S1", name: "money tree", placement: { kind: "beside", anchor: "R8", side: "east", gap: 0.3, eastWest: 0.6, northSouth: 0.6, shift: 3 }, height: 1.6, tag: TAG };
    expect(checkAnswer(answer([box]), change, [], 1, summary, opts).problems.join()).toMatch(/use a "place" step with a file from the COMPONENTS list/);
  });

  it("refuses a component the change didn't ask for", async () => {
    const { summary, opts } = await setup();
    const other = { line: 2, text: "Forest bench. A built-in light oak bench along the east face of Terrarium E, 6.0 m long, 0.5 m deep, 0.45 m high." };
    expect(checkAnswer(answer([tree]), other, [], 1, summary, opts).problems.join()).toMatch(/doesn't ask for a component/);
  });

  it("sends back a file name that isn't in the folder", async () => {
    const { summary, opts } = await setup();
    const wrong = { ...tree, component: "3DW_Money tree.skp" };
    expect(checkAnswer(answer([wrong]), change, [], 1, summary, opts).problems.join()).toMatch(/is not in the components folder; use a file name from the COMPONENTS list/);
  });
});
