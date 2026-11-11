import type { RoomSummary } from "../summary/roomSummary";
import type { Brief } from "./brief";
import type { Draft } from "./draft";
import type { Llm } from "./llm";
import { planBrief } from "./planner";
import { resolveDraft, type Action, type Plan, type ResolveOptions } from "./resolve";

/**
 * Scores a model's plan against a reference plan (e.g. instructions/1F_reception.draft.json),
 * change by change. A change counts as RIGHT when it produces the same operations with the same
 * geometry (boxes to 1 cm), whatever names or ids the model chose. This is what the benchmark
 * runs several times per model, so one lucky or unlucky answer doesn't decide which model we use.
 */

export type LineScore = { line: number; right: boolean; expected: string[]; got: string[] };
export type Score = { right: number; total: number; lines: LineScore[] };

const cm = (v: number) => (Math.round(v * 100) / 100).toFixed(2);

function signature(a: Action): string {
  const args = a.args as Record<string, unknown>;
  switch (a.tool) {
    case "moveToReplaced":
      return `replace ${JSON.stringify(args.target)}`;
    case "createPrism": {
      const pts = args.points as [number, number][];
      const xs = pts.map((p) => p[0]);
      const ys = pts.map((p) => p[1]);
      return `build x ${cm(Math.min(...xs))}..${cm(Math.max(...xs))} y ${cm(Math.min(...ys))}..${cm(Math.max(...ys))} z ${cm(args.z0 as number)}..${cm(args.z1 as number)}`;
    }
    case "applyMaterial":
      return `paint ${String(args.material).toLowerCase()}`;
    case "setTagVisibility":
      return `${args.visible ? "show" : "hide"} tag ${args.tag}`;
    case "captureView":
      return "screenshot";
    case "saveCopy":
      return "save";
    default:
      return a.tool;
  }
}

export function scorePlan(plan: Plan, reference: Plan, lines: number[]): Score {
  const byLine = (p: Plan, line: number) => p.actions.filter((a) => a.line === line).map(signature).sort();
  const scores = lines.map((line) => {
    const expected = byLine(reference, line);
    const got = byLine(plan, line);
    return { line, right: JSON.stringify(expected) === JSON.stringify(got), expected, got };
  });
  return { right: scores.filter((s) => s.right).length, total: lines.length, lines: scores };
}

export type BenchRun = {
  model: string;
  run: number;
  seconds: number;
  score: Score;
  errors: string[];
  warnings: number;
  draft: Draft | null;
  failure: string | null; // the model or Ollama failed completely
};

export async function benchOnce(
  llm: Llm,
  model: string,
  run: number,
  brief: Brief,
  summary: RoomSummary,
  summaryText: string,
  reference: Draft,
  opts: ResolveOptions,
): Promise<BenchRun> {
  const lines = brief.changes.map((c) => c.line);
  const refPlan = resolveDraft(reference, summary, opts);
  const started = Date.now();
  try {
    const out = await planBrief(llm, brief, summary, summaryText, opts);
    const plan = resolveDraft(out.draft, summary, opts);
    return {
      model,
      run,
      seconds: Math.round((Date.now() - started) / 1000),
      score: scorePlan(plan, refPlan, lines),
      errors: plan.errors,
      warnings: plan.actions.reduce((n, a) => n + a.warnings.length, 0),
      draft: out.draft,
      failure: null,
    };
  } catch (e) {
    return {
      model,
      run,
      seconds: Math.round((Date.now() - started) / 1000),
      score: { right: 0, total: lines.length, lines: [] },
      errors: [],
      warnings: 0,
      draft: null,
      failure: (e as Error).message,
    };
  }
}

/** The results table (Markdown), one row per model, plus which changes each model gets wrong. */
export function renderBench(runs: BenchRun[]): string {
  const models = [...new Set(runs.map((r) => r.model))];
  const out = [
    "| model | runs | changes right (avg of 8) | runnable plans | avg time | failures |",
    "|---|---|---|---|---|---|",
  ];
  for (const m of models) {
    const rs = runs.filter((r) => r.model === m);
    const avg = rs.reduce((n, r) => n + r.score.right, 0) / rs.length;
    const runnable = rs.filter((r) => !r.failure && r.errors.length === 0).length;
    const secs = Math.round(rs.reduce((n, r) => n + r.seconds, 0) / rs.length);
    out.push(`| ${m} | ${rs.length} | ${avg.toFixed(1)} / ${rs[0]!.score.total} | ${runnable} / ${rs.length} | ${secs} s | ${rs.filter((r) => r.failure).length} |`);
  }
  out.push("", "Changes that were wrong (model, run: lines):");
  for (const r of runs) {
    const wrong = r.score.lines.filter((l) => !l.right).map((l) => l.line);
    out.push(`- ${r.model}, run ${r.run}: ${r.failure ? `FAILED (${r.failure.split("\n")[0]})` : wrong.length ? wrong.join(", ") : "none"}${r.errors.length ? ` · ${r.errors.length} plan errors` : ""}`);
  }
  return out.join("\n");
}
