import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseBrief } from "../../src/agent/brief";
import { Draft, changeAnswerJsonSchema, draftJsonSchema, type DraftStep } from "../../src/agent/draft";
import { executePlan, renderReport } from "../../src/agent/execute";
import type { Llm } from "../../src/agent/llm";
import { briefPutsItThere, checkAnswer, planBrief } from "../../src/agent/planner";
import { t133 } from "../helpers/t133";
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

// A fake model that answers each change with the reference draft's steps for that line.
const BRIEF_TEXT = readFileSync("instructions/1F_reception.md", "utf8");
const CHECK_IT = "Check it. Hide \`1F Reception - Lighting (T128)\` for the screenshot, take an iso screenshot, show the lighting tag again, then save a copy as \`UMD_DEV_1F_reception_brief1.skp\`.";
const changeOf = (messages: { content: string }[]) => Number(messages[1]!.content.match(/Now plan ONLY change (\d+)/)![1]);
const goodAnswer = (line: number) => {
  const steps = BRIEF1.steps.filter((st) => st.line === line).map(({ line: _l, ...rest }) => rest);
  return JSON.stringify(steps.length ? { type: "steps", steps, reason: "" } : { type: "rule", steps: [], reason: "tag/material rule" });
};
const fakeModel = (override: (line: number, attempt: number) => string | null = () => null): Llm => {
  const attempts = new Map<number, number>();
  return async (messages) => {
    const line = changeOf(messages);
    const n = (attempts.get(line) ?? 0) + 1;
    attempts.set(line, n);
    return override(line, n) ?? goodAnswer(line);
  };
};

describe("parseBrief", () => {
  it("finds the 8 numbered changes and the 4 later items in brief 1", () => {
    const b = parseBrief(BRIEF_TEXT);
    expect(b.changes.map((c) => c.line)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(b.changes[0]!.text).toMatch(/Sofa set 4.*Show me what is inside/); // the indented second line belongs to it
    expect(b.later).toHaveLength(4);
    expect(b.later[0]).toMatch(/^Lowered waiting area/);
  });
});

describe("planBrief: asking the model one change at a time", () => {
  it("builds the same plan as the reference draft from good answers", async () => {
    const { summary } = await setup();
    const out = await planBrief(fakeModel(), parseBrief(BRIEF_TEXT), summary, renderSummary(summary), OPTS);
    expect(out.draft.steps).toEqual(BRIEF1.steps);
    expect(out.outcomes.map((o) => o.type)).toEqual(["steps", "steps", "steps", "steps", "steps", "rule", "rule", "steps"]);
    expect(out.draft.notDone.map((n) => n.reason)).toEqual(Array(4).fill('marked "(later)" in the brief'));
    expect(resolveDraft(out.draft, summary, OPTS).errors).toEqual([]);
  });

  it("asks about ONE change at a time and tells the model which build ids to use", async () => {
    const { summary } = await setup();
    const questions: string[] = [];
    const llm: Llm = async (messages) => {
      questions.push(messages[1]!.content);
      return goodAnswer(changeOf(messages));
    };
    await planBrief(llm, parseBrief(BRIEF_TEXT), summary, renderSummary(summary), OPTS);
    expect(questions).toHaveLength(8);
    expect(questions[2]).toMatch(/Now plan ONLY change 3/);
    expect(questions[2]).toMatch(/Already planned blocks: S1 = "Reception counter - light oak"/);
    expect(questions[2]).toMatch(/New build ids for this change: S2/);
  });

  it("replays the Windows failure: 'needs coordinates' is sent back, and the 2nd try is accepted", async () => {
    const { summary } = await setup();
    const feedback: string[] = [];
    const base = fakeModel((line, attempt) =>
      line === 2 && attempt === 1
        ? JSON.stringify({ type: "notPossible", steps: [], reason: "Cannot place a counter without knowing the exact coordinates" })
        : null,
    );
    const llm: Llm = async (messages) => {
      if (messages.length > 2) feedback.push(messages.at(-1)!.content);
      return base(messages, {});
    };
    const out = await planBrief(llm, parseBrief(BRIEF_TEXT), summary, renderSummary(summary), OPTS);
    expect(feedback[0]).toMatch(/calculated by the program/);
    expect(out.outcomes[1]).toMatchObject({ line: 2, type: "steps", tries: 2 });
  });

  it.each<[string, string, RegExp, string?]>([
    ["the same step twice", JSON.stringify({ type: "steps", steps: [{ op: "screenshot" }, { op: "screenshot" }], reason: "" }), /more than once/],
    ["steps with no steps", JSON.stringify({ type: "steps", steps: [], reason: "" }), /no steps/],
    ["a ref that doesn't exist", JSON.stringify({ type: "steps", steps: [{ op: "replace", target: "R40" }], reason: "" }), /R40 is not in the room summary/, "Take out the old desk."],
    [
      "a top on a block that doesn't exist",
      JSON.stringify({ type: "steps", steps: [{ op: "build", id: "S7", name: "x", placement: { kind: "onTop", of: "S5", overhang: 0 }, height: 0.1, tag: "T" }], reason: "" }),
      /not built before it/,
    ],
    ["calling a real change a rule", JSON.stringify({ type: "rule", steps: [], reason: "" }), /not only a rule/],
    ["not JSON", "Sure! Here is the plan:", /not valid JSON/],
    // From the Windows run of 2026-11-11:
    ["a showTag for 'add a counter' (qwen3:4b's false pass)", JSON.stringify({ type: "steps", steps: [{ op: "showTag", tag: "1F Reception - Furniture (AGENT)" }], reason: "" }), /needs a "build" step/],
    ["a screenshot the change didn't ask for (qwen3:8b, change 1)", JSON.stringify({ type: "steps", steps: [{ op: "replace", target: "R5" }, { op: "screenshot" }], reason: "" }), /doesn't ask for a screenshot/, "Take out Sofa set 4. Show me what is inside it before doing this."],
    ["showing a tag that isn't hidden", JSON.stringify({ type: "steps", steps: [{ op: "replace", target: "R5" }, { op: "showTag", tag: "1F Reception - Terrariums (T128)" }], reason: "" }), /not hidden, so showing it does nothing/, "Take out Sofa set 4. Show me what is inside it."],
    [
      "a planter outside the building (qwen3:8b, change 5: 1 m EAST of the east glass wall)",
      JSON.stringify({ type: "steps", steps: [{ op: "build", id: "S1", name: "Planter", placement: { kind: "beside", anchor: "R12", side: "east", gap: 1, eastWest: 4, northSouth: 0.6, shift: -1.2 }, height: 0.35, tag: "T" }], reason: "" }),
      /S1 ends up outside the room: the inside of R12 faces west, so use side "west"/,
      "Entrance planters. Two kerbs inside the main entrance, 4.0 m long, 0.6 m wide, 0.35 m high.",
    ],
    // From the 18:44 run (qwen3:8b):
    [
      "a new block in a change that only takes something out",
      JSON.stringify({ type: "steps", steps: [{ op: "replace", target: "R5" }, { op: "build", id: "S1", name: "Sofa set 4 - reception lounge", placement: { kind: "beside", anchor: "R1", side: "east", gap: 1.2, eastWest: 0.7, northSouth: 3 }, height: 0.851, tag: "T" }], reason: "" }),
      /doesn't ask to add anything new/,
      "Take out \"Sofa set 4\". Move it to replaced (do not delete). Show me what is inside it before doing this.",
    ],
    [
      "a block placed beside the item being taken out",
      JSON.stringify({ type: "steps", steps: [{ op: "replace", target: "R5" }, { op: "build", id: "S1", name: "x", placement: { kind: "beside", anchor: "R5", side: "east", gap: 1.2, eastWest: 0.7, northSouth: 3 }, height: 1, tag: "T" }], reason: "" }),
      /beside R5, which this plan takes out/,
      "Take out Sofa set 4 and add a counter 3.0 m long.",
    ],
    [
      "the two planters' sizes swapped (4 m long running west became north-south)",
      JSON.stringify({ type: "steps", steps: [{ op: "build", id: "S1", name: "Planter north", placement: { kind: "beside", anchor: "R12", side: "west", gap: 1, eastWest: 0.6, northSouth: 4 , shift: 0.9 }, height: 0.35, tag: "T" }], reason: "" }),
      /needs eastWest 4 \(it has 0.6\)/,
      "Entrance planters. Two kerbs inside the main entrance, each 4.0 m long running west from 1.0 m inside the glass, 0.6 m wide, 0.35 m high.",
    ],
    [
      "two new blocks that overlap each other",
      JSON.stringify({ type: "steps", steps: [
        { op: "build", id: "S1", name: "Planter north", placement: { kind: "beside", anchor: "R12", side: "west", gap: 1, eastWest: 4, northSouth: 0.6, shift: 0.2 }, height: 0.35, tag: "T" },
        { op: "build", id: "S2", name: "Planter south", placement: { kind: "beside", anchor: "R12", side: "west", gap: 1, eastWest: 4, northSouth: 0.6, shift: -0.2 }, height: 0.35, tag: "T" },
      ], reason: "" }),
      /S2 overlaps S1, another new block/,
      "Two kerbs inside the main entrance, 0.6 m wide, 0.35 m high, one each side of the path.",
    ],
    // From the benchmark of 2026-11-11 (both qwen3:8b and qwen2.5:7b):
    [
      "a bench 'along' a north-south terrarium that runs east-west",
      JSON.stringify({ type: "steps", steps: [{ op: "build", id: "S1", name: "Forest bench", placement: { kind: "beside", anchor: "R8", side: "east", gap: 0, eastWest: 6, northSouth: 0.5 }, height: 0.45, tag: "T" }], reason: "" }),
      /"along" R8, which runs north-south, so its length goes in northSouth/,
      "Forest bench. A built-in light oak bench along the east face of Terrarium E, 6.0 m long, 0.5 m deep, 0.45 m high.",
    ],
    [
      "1.8 m centre to centre when the brief says 1.8 m CLEAR",
      JSON.stringify({ type: "steps", steps: [
        { op: "build", id: "S1", name: "Kerb north", placement: { kind: "beside", anchor: "R12", side: "west", gap: 1, eastWest: 4, northSouth: 0.6, shift: 0.9 }, height: 0.35, tag: "T" },
        { op: "build", id: "S2", name: "Kerb south", placement: { kind: "beside", anchor: "R12", side: "west", gap: 1, eastWest: 4, northSouth: 0.6, shift: -0.9 }, height: 0.35, tag: "T" },
      ], reason: "" }),
      /wants 1.8 m clear between the two blocks, they have 1.20 m/,
      "Entrance planters, each 4.0 m long running west from 1.0 m inside the glass, 0.6 m wide, 0.35 m high. Keep 1.8 m clear between them for the path.",
    ],
    // From the benchmark of 2026-11-12: qwen3:8b answered change 8 with the hideTag alone. Nothing
    // complained, the plan lost its save, and so it could not be run at all.
    [
      "a 'check it' change answered with the hideTag alone",
      JSON.stringify({ type: "steps", steps: [{ op: "hideTag", tag: "1F Reception - Lighting (T128)" }], reason: "" }),
      /asks for a screenshot, but your answer has no "screenshot" step/,
      CHECK_IT,
    ],
    ["names that switch language", JSON.stringify({ type: "steps", steps: [{ op: "build", id: "S1", name: "Counter 家具", placement: { kind: "beside", anchor: "R1", side: "east", gap: 1.2, eastWest: 0.7, northSouth: 3 }, height: 1.05, tag: "T" }], reason: "" }), /English only/],
  ])("rejects %s, with a reason the model can act on", async (_, answer, problem, text) => {
    const { summary } = await setup();
    const change = { line: 2, text: text ?? "New reception counter. Add a counter 3.0 m long, 0.7 m deep, 1.05 m high." };
    expect(checkAnswer(answer, change, [], 1, summary, OPTS).problems.join("\n")).toMatch(problem);
  });

  it("asks for onTop when the change puts something ON an earlier block (the 18:44 counter-top regression)", async () => {
    const { summary } = await setup();
    const counter = BRIEF1.steps.find((st) => st.op === "build" && st.id === "S1")!;
    const answer = JSON.stringify({ type: "steps", steps: [{ op: "build", id: "S2", name: "top", placement: { kind: "beside", anchor: "R1", side: "east", gap: 1.2, eastWest: 0.7, northSouth: 3 }, height: 0.04, tag: "T" }], reason: "" });
    const change = { line: 3, text: "Counter top. A thin travertine top on the counter: same footprint plus 0.05 m overhang." };
    expect(checkAnswer(answer, change, [counter], 2, summary, OPTS).problems.join()).toMatch(/use "onTop"/);
  });

  it("does not mistake 'on the east side' or 'on the floor' for 'on top of'", async () => {
    const { summary } = await setup();
    const counter = BRIEF1.steps.find((st) => st.op === "build" && st.id === "S1")!;
    const { line: _l, ...bench } = BRIEF1.steps.find((st) => st.op === "build" && st.id === "S3")!;
    const change = { line: 4, text: "Forest bench on the east side of Terrarium E, standing on the floor, 6.0 m long, 0.5 m deep, 0.45 m high." };
    const out = checkAnswer(JSON.stringify({ type: "steps", steps: [{ ...bench, id: "S2" }], reason: "" }), change, [counter], 2, summary, OPTS);
    expect(out.problems).toEqual([]);
  });

  it("catches the counter turned 90° even when it is built under change 3 (Windows bench runs 2-3, 2026-11-12)", async () => {
    const { summary } = await setup();
    const brief = parseBrief(BRIEF_TEXT);
    const rotated = JSON.stringify({
      type: "steps",
      steps: [
        { op: "build", id: "S1", name: "Reception counter", placement: { kind: "beside", anchor: "R1", side: "east", gap: 1.2, eastWest: 3, northSouth: 0.7 }, height: 1.05, tag: "T" },
        { op: "build", id: "S2", name: "Counter top", placement: { kind: "onTop", of: "S1", overhang: 0.05 }, height: 0.04, tag: "T" },
      ],
      reason: "",
    });
    const change3 = brief.changes.find((c) => c.line === 3)!;
    const { problems } = checkAnswer(rotated, change3, [], 1, summary, OPTS, brief);
    expect(problems.join()).toMatch(/S1 looks turned 90°: the brief says "3\.0 m long \(north-south.*so set northSouth 3 and eastWest 0\.7/);
  });

  it("does not call a block 'turned' when no phrase in the brief matches it", async () => {
    const { summary } = await setup();
    const brief = parseBrief(BRIEF_TEXT);
    const { line: _l, ...bench } = BRIEF1.steps.find((st) => st.op === "build" && st.id === "S3")!;
    const change4 = brief.changes.find((c) => c.line === 4)!;
    const { problems } = checkAnswer(JSON.stringify({ type: "steps", steps: [{ ...bench, id: "S1" }], reason: "" }), change4, [], 1, summary, OPTS, brief);
    expect(problems).toEqual([]);
  });

  it("renumbers the model's build ids and keeps its onTop links pointing at the right block", async () => {
    const { summary } = await setup();
    const answer = JSON.stringify({
      type: "steps",
      steps: [
        { op: "build", id: "S9", name: "counter", placement: { kind: "beside", anchor: "R1", side: "east", gap: 1.2, eastWest: 0.7, northSouth: 3 }, height: 1.05, tag: "T" },
        { op: "build", id: "S4", name: "top", placement: { kind: "onTop", of: "S9", overhang: 0.05 }, height: 0.04, tag: "T" },
      ],
      reason: "",
    });
    const { answer: fixed, problems } = checkAnswer(answer, { line: 2, text: "Add a counter with a top" }, [], 1, summary, OPTS);
    expect(problems).toEqual([]);
    expect(fixed!.steps.map((st) => (st.op === "build" ? [st.id, st.placement.kind === "onTop" ? st.placement.of : "-"] : null))).toEqual([
      ["S1", "-"],
      ["S2", "S1"],
    ]);
  });

  it("a change that fails twice becomes NOT DONE with the reasons, and the rest still gets planned", async () => {
    const { summary } = await setup();
    const llm = fakeModel((line) => (line === 4 ? JSON.stringify({ type: "steps", steps: [], reason: "" }) : null));
    const out = await planBrief(llm, parseBrief(BRIEF_TEXT), summary, renderSummary(summary), OPTS);
    expect(out.outcomes[3]).toMatchObject({ line: 4, type: "failed", tries: 2 });
    expect(out.draft.notDone[0]).toMatchObject({ line: 4, reason: expect.stringMatching(/could not plan it/) });
    expect(out.draft.steps.some((st) => st.line === 5)).toBe(true);
  });

  it("names every step a change asked for and the answer left out (Windows 2026-11-12, change 8)", async () => {
    const { summary } = await setup();
    const answer = JSON.stringify({ type: "steps", steps: [{ op: "hideTag", tag: "1F Reception - Lighting (T128)" }], reason: "" });
    const problems = checkAnswer(answer, { line: 8, text: CHECK_IT }, [], 1, summary, OPTS).problems.join("\n");
    expect(problems).toMatch(/no "screenshot" step/);
    expect(problems).toMatch(/no "save" step/);
    expect(problems).toMatch(/no "showTag" step/);
    expect(problems).not.toMatch(/no "hideTag" step/); // it did hide the tag
  });

  it("does not ask for a showTag because change 1 says 'Show me what is inside it'", async () => {
    const { summary } = await setup();
    const answer = JSON.stringify({ type: "steps", steps: [{ op: "replace", target: "R5" }], reason: "" });
    const change = { line: 1, text: 'Take out "Sofa set 4". Move it to replaced (do not delete). Show me what is inside it before doing this.' };
    expect(checkAnswer(answer, change, [], 1, summary, OPTS).problems).toEqual([]);
  });

  it("works out the shift itself instead of giving the model a formula (Windows 2026-11-12, change 5)", async () => {
    const { summary } = await setup();
    const kerb = (id: string, shift: number) => ({
      op: "build", id, name: `Kerb ${id}`, height: 0.35, tag: "T",
      placement: { kind: "beside", anchor: "R12", side: "west", gap: 1, eastWest: 4, northSouth: 0.6, shift },
    });
    const answer = JSON.stringify({ type: "steps", steps: [kerb("S1", 0.9), kerb("S2", -0.9)], reason: "" });
    const change = { line: 5, text: "Entrance planters, each 4.0 m long running west from 1.0 m inside the glass, 0.6 m wide, 0.35 m high. Keep 1.8 m clear between them for the path." };
    const problems = checkAnswer(answer, change, [], 1, summary, OPTS).problems.join("\n");
    // 1.8 clear between two 0.6-wide kerbs -> each centre 1.2 from the middle, as in the reference draft.
    expect(problems).toMatch(/set shift to 1.2 on one and -1.2 on the other/);
  });

  it("treats a change already planned under an earlier one as done, not NOT DONE (Windows 2026-11-12, change 3)", async () => {
    const { summary } = await setup();
    const bare = (line: number) => BRIEF1.steps.filter((st) => st.line === line).map(({ line: _l, ...rest }) => rest);
    const counterAndTop = JSON.stringify({ type: "steps", steps: [...bare(2), ...bare(3)], reason: "" });
    const topAgain = JSON.stringify({ type: "steps", steps: bare(3), reason: "" });
    const llm = fakeModel((line) => (line === 2 ? counterAndTop : line === 3 ? topAgain : null));
    const out = await planBrief(llm, parseBrief(BRIEF_TEXT), summary, renderSummary(summary), OPTS);

    expect(out.outcomes[2]).toMatchObject({ line: 3, type: "steps", steps: 0 });
    expect(out.draft.notDone.some((n) => n.line === 3)).toBe(false);
    // the counter top is in the plan once, under change 2, and the plan still runs
    expect(out.draft.steps.filter((st) => st.op === "build" && st.placement.kind === "onTop")).toHaveLength(1);
    expect(resolveDraft(out.draft, summary, OPTS).errors).toEqual([]);
  });

  it("names the side that faces into the room instead of saying 'check side' (Windows 2026-11-12, change 5)", async () => {
    const { summary } = await setup();
    // R12 is the EAST GLASS WALL at the room's east edge: qwen3:8b read the name and used side "east".
    const kerb = (id: string, shift: number) => ({
      op: "build", id, name: `Kerb ${id}`, height: 0.35, tag: "T",
      placement: { kind: "beside", anchor: "R12", side: "east", gap: 1, eastWest: 4, northSouth: 0.6, shift },
    });
    const answer = JSON.stringify({ type: "steps", steps: [kerb("S1", 1.2), kerb("S2", -1.2)], reason: "" });
    const change = { line: 5, text: "Entrance planters, two kerbs inside the main entrance (the gap in EAST GLASS WALL), each 4.0 m long running west, 0.6 m wide, 0.35 m high." };
    const problems = checkAnswer(answer, change, [], 1, summary, OPTS).problems.join("\n");
    expect(problems).toMatch(/the inside of R12 faces west, so use side "west"/);
  });

  it("accepts the reference draft's kerbs, which stand on the inside face", async () => {
    const { summary } = await setup();
    const steps = BRIEF1.steps.filter((st) => st.line === 5).map(({ line: _l, ...rest }) => rest);
    const change = { line: 5, text: "Entrance planters, each 4.0 m long running west from 1.0 m inside the glass, 0.6 m wide, 0.35 m high. Keep 1.8 m clear between them for the path." };
    expect(checkAnswer(JSON.stringify({ type: "steps", steps, reason: "" }), change, [], 4, summary, OPTS).problems).toEqual([]);
  });

  // Windows 2026-11-13, brief 3: qwen3:8b planned all four changes correctly and lost two of them to
  // formatting - "north-west" copied from the brief's own wording, and "" for a view with no target.
  it.each<[string, Record<string, unknown>, Record<string, unknown>]>([
    ["a compass word hyphenated, as the brief writes it", { from: "north-west", toward: "R1" }, { from: "northwest", toward: "R1" }],
    ["a compass word with a space", { from: "south east" }, { from: "southeast" }],
    ["an empty toward for a view of nothing in particular", { from: "above", toward: "" }, { from: "above" }],
    ["a lower-case item ref", { from: "r12", toward: "r1" }, { from: "R12", toward: "R1" }],
  ])("accepts %s", async (_, given, wanted) => {
    const { summary } = await setup();
    const step = { op: "scene", name: "1F Reception - seated", eyeHeight: 1.1, ...given };
    const change = { line: 2, text: "Save a scene called `1F Reception - seated`, from the north-west corner, looking toward Terrarium A." };
    const out = checkAnswer(JSON.stringify({ type: "steps", steps: [step], reason: "" }), change, [], 1, summary, OPTS);
    expect(out.problems).toEqual([]);
    expect(out.answer!.steps[0]).toMatchObject({ op: "scene", ...wanted });
    if ("toward" in wanted === false) expect(out.answer!.steps[0]).not.toHaveProperty("toward");
  });

  it("leaves a compass word it does not recognise to the schema, so a typo is still reported", async () => {
    const { summary } = await setup();
    const step = { op: "scene", name: "view", from: "north-northwest", eyeHeight: 1.6 };
    const change = { line: 2, text: "Save a scene called `view` from the north-northwest corner." };
    const out = checkAnswer(JSON.stringify({ type: "steps", steps: [step], reason: "" }), change, [], 1, summary, OPTS);
    expect(out.problems.join()).toMatch(/a side of the room/);
  });

  it("sends Ollama schemas it accepts (no prefixItems / items:false, Windows fix 543957a)", () => {
    for (const schema of [draftJsonSchema(), changeAnswerJsonSchema()]) {
      const text = JSON.stringify(schema);
      expect(text).not.toContain("prefixItems");
      expect(text).not.toContain('"items":false');
    }
  });
});

describe("resolveDraft: catches a model stuck in a loop", () => {
  it("refuses the hide/screenshot/show loop seen on Windows", async () => {
    const { summary } = await setup();
    const loop: DraftStep[] = [];
    for (let i = 0; i < 5; i++) {
      loop.push({ op: "hideTag", line: 8, tag: "L" }, { op: "screenshot", line: 8 }, { op: "showTag", line: 8, tag: "L" });
    }
    const errors = resolveDraft(withSteps([...loop, SAVE]), summary, OPTS).errors.join("\n");
    expect(errors).toMatch(/5 screenshots: the plan is repeating itself/);
    expect(errors).toMatch(/10 tag hide\/show steps/);
  });

  it("allows a second screenshot later in the plan (Windows: it used to kill the save in change 8)", async () => {
    const { summary } = await setup();
    const steps: DraftStep[] = [
      { op: "replace", line: 1, target: "R5" },
      { op: "screenshot", line: 1 },
      ...BRIEF1.steps.filter((st) => st.line === 8),
    ];
    expect(resolveDraft(withSteps(steps), summary, OPTS).errors).toEqual([]);
  });

  it("still refuses building the same thing twice, even with different ids", async () => {
    const { summary } = await setup();
    const counter = BRIEF1.steps.find((st) => st.op === "build" && st.id === "S1")!;
    const errors = resolveDraft(withSteps([counter, { ...counter, id: "S9", line: 4 } as DraftStep, SAVE]), summary, OPTS).errors;
    expect(errors.join()).toMatch(/same build step appears more than once/);
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

  // Windows, 2026-11-13: the iso view from outside framed roofs. Now: one eye-level picture per group of new pieces,
  // from a camera that stands on the floor near them, aimed at them. No iso view, and no scene tab added.
  it("takes an eye-level picture of each group of new pieces, aimed at them (no iso view)", async () => {
    const { sketchup, client, summary } = await setup();
    const plan = resolveDraft(BRIEF1, summary, OPTS);
    const shots = plan.actions.filter((a) => a.tool === "captureView");
    expect(shots.map((a) => a.viewOf)).toEqual([["S1", "S2"], ["S3"], ["S4", "S5"]]); // counter+top, forest bench, entrance kerbs
    for (const a of shots) {
      const cam = a.args.camera as { eye: number[]; target: number[] };
      expect(cam.eye[2]).toBeCloseTo(summary.floor.z + 1.6, 3); // eye level
      expect(cam.target[2]).toBe(cam.eye[2]); // level: walls stay vertical
      expect(a.args.zoomTo).toBeUndefined();
    }
    const scenesBefore = [...sketchup.scenes];
    await executePlan(client, plan);
    const sent = sketchup.received.filter((c) => c.tool === "captureView");
    expect(sent.map((c) => c.args.fileName)).toEqual(["1F_reception_test_1.png", "1F_reception_test_2.png", "1F_reception_test_3.png"]);
    expect(sent.every((c) => c.args.camera && !c.args.zoomTo)).toBe(true);
    expect(sketchup.scenes).toEqual(scenesBefore); // a picture, not a new scene tab
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
    expect(report).toContain("all 17 actions ran");
    expect(report).toContain(renderPlan(plan).split("\n")[2]);
    expect(report).toContain("R5  Sofa set 4");
  });
});

// Windows, 2026-11-13 (brief 5, PowerShell run 230100): qwen3:8b answered both genkan benches EXACTLY like the
// reference draft and was rejected twice. The "outside the room" rule treated a whole room as a wall: for the
// breathing room it said "use north" (already north), for the meditation room "use south" - into the raised tatami.
describe("brief 5: a block the brief itself puts outside the room", () => {
  const brief = parseBrief(readFileSync("instructions/1F_meditation_build.md", "utf8"));
  const opts = { runId: "t", briefName: "1F_meditation_build" };
  const bench = (anchor: string, side: string, shift: number) =>
    JSON.stringify({
      type: "steps",
      steps: [{ op: "build", id: "S1", name: "Genkan bench - light oak", placement: { kind: "beside", anchor, side, gap: 0.14, eastWest: 2.0, northSouth: 0.35, shift }, height: 0.45, tag: "1F Meditation - Furniture (AGENT)", material: { name: "UMD Light Oak", rgb: [196, 164, 120] } }],
      reason: "",
    });

  it("accepts the model's real answers: 0.14 m north of each room, in the hallway", () => {
    const { summary } = t133();
    for (const [line, anchor, shift] of [[1, "R2", 5.2], [2, "R1", -5.4]] as const) {
      const change = brief.changes.find((c) => c.line === line)!;
      expect(checkAnswer(bench(anchor, "north", shift), change, [], 1, summary, opts, brief).problems).toEqual([]);
    }
  });

  it("still rejects the retry it was pushed into (south of the meditation room), without a wrong hint", () => {
    const { summary } = t133();
    const change = brief.changes.find((c) => c.line === 2)!;
    const p = checkAnswer(bench("R1", "south", -5.4), change, [], 1, summary, opts, brief).problems.join();
    expect(p).toMatch(/S1 ends up outside the room/);
    expect(p).not.toMatch(/use side "south"/);
  });

  it("only the brief's own words count: a wall's NAME is not a side", () => {
    const { refs } = t133();
    const r2 = refs.get("R2")!;
    expect(briefPutsItThere("0.14 m north of the `BREATHING ROOM`, shifted 5.2 m east", "north", r2)).toBe(true);
    expect(briefPutsItThere("0.14 m north of the BREATHING ROOM, shifted 5.2 m east", "north", r2)).toBe(true);
    expect(briefPutsItThere("0.14 m north of the `BREATHING ROOM`", "south", r2)).toBe(false);
    expect(briefPutsItThere("0.14 m north of the `MEDITATION ROOM`", "north", r2)).toBe(false);
    const wall = { ...r2, name: "EAST GLASS WALL (T132) - floor-to-ceiling low-iron glass" };
    expect(briefPutsItThere("Two kerbs inside the main entrance (the gap in the middle of `EAST GLASS WALL (T132)`)", "east", wall)).toBe(false);
  });
});
