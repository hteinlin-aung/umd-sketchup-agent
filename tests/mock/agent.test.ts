import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { Draft, draftJsonSchema, type DraftStep } from "../../src/agent/draft";
import { executePlan, renderReport } from "../../src/agent/execute";
import type { Llm } from "../../src/agent/llm";
import { PlanningError, draftPlan } from "../../src/agent/planner";
import { overlaps, renderPlan, resolveDraft } from "../../src/agent/resolve";
import { BridgeClient } from "../../src/bridge/client";
import { MockSketchUp } from "../../src/bridge/mockSketchUp";
import { renderSummary, summarizeRoom } from "../../src/summary/roomSummary";

// MOCK: step 2c (draft -> plan -> run) on the fake reception room, which has the REAL
// positions from the Windows summary of 2026-11-11. The language model is a fake here;
// the real one (Ollama) is only tested on Windows.

const ROOM = "1F RECEPTION - TERRARIUMS + LOUNGE (T128, per revised plan)";
const BRIEF1 = Draft.parse(JSON.parse(readFileSync("instructions/1F_reception.draft.json", "utf8")));
const OPTS = { runId: "test", briefName: "1F_reception" };

const setup = async (opts: ConstructorParameters<typeof MockSketchUp>[0] = {}) => {
  const sketchup = new MockSketchUp({ scene: "reception", ...opts });
  const client = new BridgeClient(sketchup);
  const summary = await summarizeRoom(client, { path: [ROOM] });
  return { sketchup, client, summary };
};

const withSteps = (steps: DraftStep[]): Draft => ({ steps, notDone: [] });
const SAVE: DraftStep = { op: "save", line: 9, fileName: "out.skp" };

describe("resolveDraft: the code does the arithmetic", () => {
  it("puts the counter 1.2 m east of Terrarium A, centred on it, on the 1F floor", async () => {
    const { summary } = await setup();
    const plan = resolveDraft(BRIEF1, summary, OPTS);
    expect(plan.errors).toEqual([]);
    const counter = plan.actions.find((a) => a.builds === "S1")!;
    // Terrarium A: x 88.362..89.956, y 98.833..105.707 -> centre y 102.27
    expect(counter.args.points).toEqual([[91.156, 100.77], [91.856, 100.77], [91.856, 103.77], [91.156, 103.77]]);
    expect([counter.args.z0, counter.args.z1]).toEqual([1.489, 2.539]);
  });

  it("puts the top on the counter, 5 cm bigger all round, 4 cm thick", async () => {
    const { summary } = await setup();
    const top = resolveDraft(BRIEF1, summary, OPTS).actions.find((a) => a.builds === "S2")!;
    expect(top.args.points).toEqual([[91.106, 100.72], [91.906, 100.72], [91.906, 103.82], [91.106, 103.82]]);
    expect([top.args.z0, top.args.z1]).toEqual([2.539, 2.579]);
  });

  it("keeps 1.8 m clear between the two entrance kerbs", async () => {
    const { summary } = await setup();
    const actions = resolveDraft(BRIEF1, summary, OPTS).actions;
    const north = actions.find((a) => a.builds === "S4")!.args.points as number[][];
    const south = actions.find((a) => a.builds === "S5")!.args.points as number[][];
    expect(north[0]![1]! - south[2]![1]!).toBeCloseTo(1.8, 6);
    expect(north[0]![0]).toBeCloseTo(101.232 - 1.0 - 4.0, 6); // 1 m inside the glass, 4 m deep
  });

  it("warns when a new box overlaps an existing item, and not when it doesn't", async () => {
    const { summary } = await setup();
    const actions = resolveDraft(BRIEF1, summary, OPTS).actions;
    expect(actions.find((a) => a.builds === "S1")!.warnings).toEqual([]);
    expect(actions.find((a) => a.builds === "S3")!.warnings.join()).toMatch(/R10/); // bench vs lounge bay box
    expect(actions.find((a) => a.builds === "S4")!.warnings.join()).toMatch(/R11/); // north kerb vs NE lounge
  });

  it("shows what a replaced item really contains, with its warning", async () => {
    const { summary } = await setup();
    const hide = resolveDraft(BRIEF1, summary, OPTS).actions[0]!;
    expect(hide.tool).toBe("moveToReplaced");
    expect(hide.details[0]).toMatch(/parlor palm/);
    expect(hide.warnings[0]).toMatch(/sofa/);
  });

  it("paints each new shape right after building it", async () => {
    const { summary } = await setup();
    const actions = resolveDraft(BRIEF1, summary, OPTS).actions;
    const i = actions.findIndex((a) => a.builds === "S1");
    expect(actions[i + 1]).toMatchObject({ tool: "applyMaterial", targetsStep: "S1", args: { material: "UMD Light Oak", color: [196, 164, 120] } });
  });

  it("never overwrites: the saved copy gets the run id", async () => {
    const { summary } = await setup();
    const save = resolveDraft(BRIEF1, summary, OPTS).actions.at(-1)!;
    expect(save.args).toEqual({ fileName: "UMD_DEV_1F_reception_brief1_test.skp" });
  });

  it.each<[string, DraftStep[], RegExp]>([
    ["a ref that doesn't exist", [{ op: "replace", line: 1, target: "R99" }, SAVE], /R99 is not in the room summary/],
    [
      "a top on a shape that isn't built",
      [{ op: "build", line: 1, id: "S2", name: "top", placement: { kind: "onTop", of: "S1", overhang: 0 }, height: 0.04, base: 0, tag: "T" }, SAVE],
      /not built before it/,
    ],
    ["no save at all", [{ op: "screenshot", line: 1 }], /never saves a copy/],
    ["a step after the save", [SAVE, { op: "hideTag", line: 9, tag: "X" }], /after the save/],
    ["a copy called MASTER", [{ ...SAVE, fileName: "UMD MASTER v2" } as DraftStep], /must not be called MASTER/],
  ])("refuses %s", async (_, steps, error) => {
    const { summary } = await setup();
    expect(resolveDraft(withSteps(steps), summary, OPTS).errors.join("\n")).toMatch(error);
  });

  it("only counts real overlaps, not boxes that just touch", () => {
    const a = { min: [0, 0, 0], max: [1, 1, 1] } as const;
    expect(overlaps({ ...a } as never, { min: [1, 0, 0], max: [2, 1, 1] } as never)).toBe(false);
    expect(overlaps({ ...a } as never, { min: [0.5, 0.5, 0.5], max: [2, 2, 2] } as never)).toBe(true);
  });
});

describe("draftPlan: asking the model", () => {
  const answer = JSON.stringify(BRIEF1);

  it("accepts a good answer on the first try", async () => {
    const llm: Llm = async () => answer;
    const out = await draftPlan(llm, "brief", "summary");
    expect(out.tries).toBe(1);
    expect(out.draft.steps).toHaveLength(BRIEF1.steps.length);
  });

  it("tells the model what was wrong and lets it try again", async () => {
    const seen: string[] = [];
    let call = 0;
    const llm: Llm = async (messages) => {
      seen.push(messages.at(-1)!.content);
      return call++ === 0 ? '{"steps": [{"op": "fly"}]}' : answer;
    };
    const out = await draftPlan(llm, "brief", "summary");
    expect(out.tries).toBe(2);
    expect(seen[1]).toMatch(/That plan has problems/);
  });

  it("feeds back problems found by the resolver too (e.g. an unknown ref)", async () => {
    const { summary } = await setup();
    const bad = JSON.stringify(withSteps([{ op: "replace", line: 1, target: "R40" }, SAVE]));
    let call = 0;
    const llm: Llm = async (messages) => (call++ === 0 ? bad : (expect(messages.at(-1)!.content).toMatch(/R40/), answer));
    const out = await draftPlan(llm, "b", renderSummary(summary), (d) => resolveDraft(d, summary, OPTS).errors);
    expect(out.tries).toBe(2);
  });

  it("gives up after two bad answers and keeps them for you to read", async () => {
    const llm: Llm = async () => "not json";
    const err = await draftPlan(llm, "b", "s").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PlanningError);
    expect((err as PlanningError).answers).toEqual(["not json", "not json"]);
  });

  it("gives Ollama a JSON schema with every operation", () => {
    const text = JSON.stringify(draftJsonSchema());
    for (const op of ["replace", "build", "hideTag", "showTag", "screenshot", "save", "beside", "onTop"]) expect(text).toContain(`"${op}"`);
  });
});

describe("executePlan: running the approved plan", () => {
  it("runs brief 1 end to end on the fake room", async () => {
    const { sketchup, client, summary } = await setup();
    const plan = resolveDraft(BRIEF1, summary, OPTS);
    const run = await executePlan(client, plan);
    expect(run.results.filter((r) => !r.ok)).toEqual([]);
    expect(run.stoppedAt).toBeNull();
    expect(run.savedPath).toMatch(/UMD_DEV_1F_reception_brief1_test\.skp$/);
    const counter = sketchup.allEntities().find((e) => e.name === "Reception counter - light oak")!;
    expect(counter.faces.every((f) => f.material === "UMD Light Oak")).toBe(true);
    const sofa4 = sketchup.allEntities().find((e) => e.name.startsWith("Sofa set 4"))!;
    expect(sofa4.tag).toBe("zz_REPLACED by 1F_reception line 1 (hidden)");
    expect(sketchup.tags.get("1F Reception - Lighting (T128)")).toBe(true); // shown again before saving
  });

  it("stops at the first failure and does not save", async () => {
    const { sketchup, client, summary } = await setup();
    const plan = resolveDraft(BRIEF1, summary, OPTS);
    sketchup.injectFailure("createPrism", "VERIFY_FAILED", "measured size is wrong");
    const run = await executePlan(client, plan);
    expect(run.stoppedAt).toBe(2);
    expect(run.savedPath).toBeNull();
    expect(sketchup.received.map((c) => c.tool)).not.toContain("saveCopy");
  });

  it("is refused by the bridge on the MASTER", async () => {
    const { client, summary } = await setup({ modelPath: "E:/Cowork_Field/Thesis_SketchUp/Urban_Mind_Detox_MASTER_Presentation_Scenes_v01.skp" });
    const run = await executePlan(client, resolveDraft(BRIEF1, summary, OPTS));
    expect(run.stoppedAt).toBe(1);
    expect(run.results[0]!.message).toMatch(/WRONG_MODEL/);
  });

  it("will not run a plan that has errors", async () => {
    const { client, summary } = await setup();
    const plan = resolveDraft(withSteps([{ op: "screenshot", line: 1 }]), summary, OPTS);
    await expect(executePlan(client, plan)).rejects.toThrow(/errors/);
  });

  it("writes a report with the plan, the results and what the model saw", async () => {
    const { client, summary } = await setup();
    const plan = resolveDraft(BRIEF1, summary, OPTS);
    const run = await executePlan(client, plan);
    const report = renderReport({ brief: "1. hide sofa", summaryText: renderSummary(summary), plan, run, model: "fake" });
    expect(report).toContain("all 15 actions ran");
    expect(report).toContain(renderPlan(plan).split("\n")[2]);
    expect(report).toContain("R5  Sofa set 4");
  });
});
