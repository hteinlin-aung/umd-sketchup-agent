import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { benchOnce, renderBench, scorePlan } from "../../src/agent/bench";
import { parseBrief } from "../../src/agent/brief";
import { Draft, type ChangeStep, type DraftStep } from "../../src/agent/draft";
import type { Llm } from "../../src/agent/llm";
import { resolveDraft } from "../../src/agent/resolve";
import { BridgeClient } from "../../src/bridge/client";
import { MockSketchUp } from "../../src/bridge/mockSketchUp";
import { renderSummary, summarizeRoom } from "../../src/summary/roomSummary";

// MOCK: the benchmark's scoring, with fake models. The real comparison runs on Windows with Ollama.

const ROOM = "1F RECEPTION - TERRARIUMS + LOUNGE (T128, per revised plan)";
const REF = Draft.parse(JSON.parse(readFileSync("instructions/1F_reception.draft.json", "utf8")));
const BRIEF = parseBrief(readFileSync("instructions/1F_reception.md", "utf8"));
const OPTS = { runId: "bench", briefName: "1F_reception" };
const LINES = [1, 2, 3, 4, 5, 6, 7, 8];

const setup = async () => {
  const client = new BridgeClient(new MockSketchUp({ scene: "reception" }));
  const summary = await summarizeRoom(client, { path: [ROOM] });
  return { summary, text: renderSummary(summary) };
};

/** A fake model that answers like the reference, optionally with a change of our choosing. */
const model = (tweak: (line: number, steps: ChangeStep[]) => ChangeStep[] = (_, s) => s): Llm =>
  async (messages) => {
    const line = Number(messages[1]!.content.match(/Now plan ONLY change (\d+)/)![1]);
    const steps = tweak(line, REF.steps.filter((st) => st.line === line).map(({ line: _l, ...rest }) => rest as ChangeStep));
    return JSON.stringify(steps.length ? { type: "steps", steps, reason: "" } : { type: "rule", steps: [], reason: "rule" });
  };

describe("benchmark scoring", () => {
  it("the reference scores 8 of 8 against itself", async () => {
    const { summary } = await setup();
    const plan = resolveDraft(REF, summary, OPTS);
    expect(scorePlan(plan, plan, LINES).right).toBe(8);
  });

  it("ignores names and ids, but not geometry", async () => {
    const { summary } = await setup();
    const renamed = REF.steps.map((st) => (st.op === "build" ? { ...st, name: `${st.name} (renamed)` } : st));
    const moved = REF.steps.map((st) => (st.op === "build" && st.id === "S3" ? { ...st, height: 0.5 } : st));
    const ref = resolveDraft(REF, summary, OPTS);
    expect(scorePlan(resolveDraft({ ...REF, steps: renamed }, summary, OPTS), ref, LINES).right).toBe(8);
    const score = scorePlan(resolveDraft({ ...REF, steps: moved }, summary, OPTS), ref, LINES);
    expect(score.right).toBe(7);
    expect(score.lines.find((l) => !l.right)!.line).toBe(4); // the bench is 0.5 high instead of 0.45
  });

  it("scores by content: the counter top under change 2 instead of 3 still counts (qwen3:8b, 2026-11-11)", async () => {
    const { summary } = await setup();
    const early = REF.steps.map((st) => (st.op === "build" && st.id === "S2" ? { ...st, line: 2 } : st));
    const score = scorePlan(resolveDraft({ ...REF, steps: early }, summary, OPTS), resolveDraft(REF, summary, OPTS), LINES);
    expect(score.right).toBe(8);
    expect(score.extra).toEqual([]);
  });

  it("lists what a wrong change is missing, and actions the reference doesn't have", async () => {
    const { summary } = await setup();
    const steps = [...REF.steps.filter((st) => !(st.op === "build" && st.id === "S5")), { op: "screenshot", line: 1 } as DraftStep];
    const score = scorePlan(resolveDraft({ ...REF, steps }, summary, OPTS), resolveDraft(REF, summary, OPTS), LINES);
    expect(score.lines.find((l) => l.line === 5)!.missing[0]).toMatch(/^build x 96\.23\.\.100\.23 y 101\.78/);
    expect(score.extra).toContain("screenshot"); // plus change 5's leftover planter and paints
  });

  it("a perfect fake model scores 8/8 with a runnable plan", async () => {
    const { summary, text } = await setup();
    const r = await benchOnce(model(), "perfect", 1, BRIEF, summary, text, REF, OPTS);
    expect([r.score.right, r.errors, r.failure]).toEqual([8, [], null]);
  });

  it("swapped planter sizes (tonight's qwen3:8b mistake) lose change 5 only", async () => {
    const { summary, text } = await setup();
    const swap = model((line, steps) =>
      line !== 5
        ? steps
        : steps.map((st) =>
            st.op === "build" && st.placement.kind === "beside"
              ? { ...st, placement: { ...st.placement, eastWest: st.placement.northSouth, northSouth: st.placement.eastWest } }
              : st,
          ),
    );
    const r = await benchOnce(swap, "swapper", 1, BRIEF, summary, text, REF, OPTS);
    expect(r.score.right).toBe(7); // the checker sends it back twice, then change 5 is NOT DONE
    expect(r.score.lines.find((l) => !l.right)!.line).toBe(5);
  });

  it("renders one row per model and lists the wrong changes", async () => {
    const { summary, text } = await setup();
    const runs = [await benchOnce(model(), "good", 1, BRIEF, summary, text, REF, OPTS), await benchOnce(async () => "nope", "bad", 1, BRIEF, summary, text, REF, OPTS)];
    const table = renderBench(runs);
    expect(table).toContain("| good | 1 | 8.0 / 8 | 0.0 | 1 / 1 |");
    expect(table).toMatch(/\| bad \| 1 \| 0\.0 \/ 8 \| 0\.0 \| 0 \/ 1 \|/);
  });
});
