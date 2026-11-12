import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { scorePlan } from "../../src/agent/bench";
import { fitComponent, loadCatalog, plausibility, renderCatalog, turnedSize } from "../../src/agent/catalog";
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
    expect(measuredFirst).toBe(7); // the fake folder has 7 files

    sketchup.components.set("3DW_Fittonia.skp", { bytes: 300_000, size: [0.3, 0.3, 0.25] });
    await loadCatalog(client, { cachePath: path });
    const measuredAgain = sketchup.received.filter((c) => c.tool === "componentInfo").map((c) => c.args.file);
    expect(measuredAgain.slice(measuredFirst)).toEqual(["3DW_Fittonia.skp", "3DW_Huge test model.skp"]); // new + the one that failed
    expect(JSON.parse(readFileSync(path, "utf8"))).toHaveLength(7); // 8 files, the 61 MB one is not usable
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

describe("scale-to-fit: what size should it be? (real sizes from Windows, 2026-11-12)", () => {
  it.each<[string, [number, number, number], number, RegExp]>([
    ["3DW_coffee_table_marble_round.skp", [3.955, 3.915, 2.636], 0.42, /a coffee table 2\.64 m high is outside the usual 0\.3-0\.55 m, so it is scaled to 0\.42 m/],
    ["3DW_easel_white_canvas.skp", [2.93, 3.6, 1.77], 1.77, /^$/], // 1.77 m high is a normal easel: left alone
    ["3DW_zen_garden_MarkE.skp", [16.3, 8.14, 5.36], 3.0, /zen garden or rocks 16\.3 m across .* scaled to 3 m/],
    ["3DW_banyan_tree_3D_MananC.skp", [24, 24, 15], 2.8, /an indoor tree 15 m high .* scaled to 2\.8 m/],
  ])("%s", (file, size, wantedKey, why) => {
    const fit = fitComponent(file, size)!;
    const key = /zen/.test(file) ? Math.max(fit.size[0], fit.size[1]) : fit.size[2];
    expect(key).toBeCloseTo(wantedKey, 2);
    expect(fit.reason ?? "").toMatch(why);
  });

  it("keeps proportions: one scale for all three directions", () => {
    const fit = fitComponent("3DW_coffee_table_marble_round.skp", [3.955, 3.915, 2.636])!;
    expect(fit.size[0] / fit.size[2]).toBeCloseTo(3.955 / 2.636, 3);
    expect(fit.scale).toBeCloseTo(0.42 / 2.636, 4);
  });

  it("leaves a normal piece alone", () => {
    expect(fitComponent("3DW_Mercy S curved boucle sofa.skp", [1.7, 3.0, 0.8])).toEqual({ scale: 1, size: [1.7, 3.0, 0.8], reason: null });
  });

  it("the brief's own size wins", () => {
    const fit = fitComponent("3DW_coffee_table_marble_round.skp", [3.955, 3.915, 2.636], { wanted: { across: 1.1 } })!;
    expect(Math.max(fit.size[0], fit.size[1])).toBeCloseTo(1.1, 3);
    expect(fit.reason).toMatch(/to the brief's size \(1\.1 m across\)/);
  });

  it("always fits under the ceiling", () => {
    const fit = fitComponent("3DW_Banyan tree.skp", [3.2, 3.0, 4.6], { roomHeight: 3.5 })!;
    expect(fit.size[2]).toBeCloseTo(2.8, 3); // the tree rule already makes it 2.8 m, which fits under 3.3
    const tall = fitComponent("3DW_Banyan tree.skp", [3.2, 3.0, 4.6], { roomHeight: 2.6, wanted: { height: 3.5 } })!;
    expect(tall.size[2]).toBeCloseTo(2.4, 3);
    expect(tall.reason).toMatch(/then made 2\.4 m high to fit under the ceiling/);
  });

  it("refuses only what it can't judge: an unknown kind of thing over 12 m, with no size in the brief", () => {
    expect(fitComponent("3DW_mystery_object.skp", [20, 3, 2])).toBeNull();
    expect(plausibility("3DW_mystery_object.skp", [20, 3, 2])).toMatch(/give its size in the brief/);
    expect(fitComponent("3DW_mystery_object.skp", [20, 3, 2], { wanted: { across: 2 } })!.scale).toBeCloseTo(0.1, 4);
  });

  it("shows the model each piece at the size it will be placed", async () => {
    const { sketchup, client } = await setup();
    sketchup.components.set("3DW_coffee_table_marble_round.skp", { bytes: 500_000, size: [3.955, 3.915, 2.636] });
    const { catalog } = await loadCatalog(client, { cachePath: cache() });
    expect(renderCatalog(catalog)).toMatch(/3DW_coffee_table_marble_round\.skp: 0\.63 x 0\.62 x 0\.42 {2}\(file drawn at the wrong scale; placed at this size\)/);
  });

  it("places the mis-scaled table at its fitted size and says why in the plan", async () => {
    const { sketchup, client, summary } = await setup();
    sketchup.components.set("3DW_coffee_table_marble_round.skp", { bytes: 500_000, size: [3.955, 3.915, 2.636] });
    const { catalog } = await loadCatalog(client, { cachePath: cache() });
    const table = { ...moneyTree, component: "3DW_coffee_table_marble_round.skp" } as DraftStep;
    const plan = resolveDraft({ steps: [table, save], notDone: [] }, summary, { runId: "x", briefName: "p", catalog });
    expect(plan.errors).toEqual([]);
    const a = plan.actions[0]!;
    expect(a.args.scale).toBeCloseTo(0.1593, 4);
    expect(a.box!.max[2] - a.box!.min[2]).toBeCloseTo(0.42, 3);
    expect(a.details.join("\n")).toMatch(/SCALED ×0\.1593: a coffee table 2\.64 m high is outside/);
    const run = await executePlan(new BridgeClient(sketchup), plan);
    expect(run.results[0]!.message).toMatch(/measured 0\.630 x 0\.624 x 0\.420 m/);
  });

  it("uses the brief's size when the place step gives one", async () => {
    const { summary, opts } = await setup();
    const sized = { ...moneyTree, size: { height: 2.0 } } as DraftStep;
    const a = resolveDraft({ steps: [sized, save], notDone: [] }, summary, opts).actions[0]!;
    expect(a.box!.max[2] - a.box!.min[2]).toBeCloseTo(2.0, 3);
  });

  it("shows each placed component's height against a door", async () => {
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

describe("scaling a file that is drawn at the wrong size (Windows 2026-11-12)", () => {
  it("lifts a too-small piece only to the bottom of the range, not to the typical size", () => {
    // A fittonia really is a 10 cm plant. It was being blown up x12 to 1.2 m and placed as a
    // 3.5 m wide "money tree". The smallest correction that makes it plausible is the right one.
    const fit = fitComponent("3DW_fittonia_SashaAlonso.skp", [0.29, 0.27, 0.1]);
    expect(fit!.size[2]).toBeCloseTo(0.15, 3);
    expect(fit!.scale).toBeLessThan(2);
  });

  it("still cuts a too-big piece down to the typical size", () => {
    const fit = fitComponent("3DW_coffee_table_marble_round.skp", [3.96, 3.92, 2.64]);
    expect(fit!.size[2]).toBeCloseTo(0.42, 3);
  });

  it("does not treat a basket of yoga mats as a mat", () => {
    expect(plausibility("3DW_yoga_mats_basket_carolineruss.skp", [0.66, 0.58, 0.79])).toBeNull();
    expect(plausibility("3DW_yoga_mat_WhoR.skp", [1.83, 0.8, 0.14])).toBeNull();
  });
});
