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

export type LineScore = { line: number; right: boolean; expected: string[]; missing: string[] };
export type Score = { right: number; total: number; lines: LineScore[]; extra: string[] };

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
    case "placeComponent": {
      const at = args.at as number[];
      return `place ${String(args.file).toLowerCase()} at ${at.map(cm).join(",")} turned ${args.rotation} x${Number(args.scale ?? 1).toFixed(3)}`;
    }
    case "applyMaterial":
      return `paint ${String(args.material).toLowerCase()}`;
    case "setTagVisibility":
      return `${args.visible ? "show" : "hide"} tag ${args.tag}`;
    case "captureView":
      return "screenshot";
    case "addScene":
      return `scene ${(args.eye as number[]).map(cm).join(",")} -> ${(args.target as number[]).map(cm).join(",")}`;
    case "saveCopy":
      return "save";
    default:
      return a.tool;
  }
}

/**
 * Scored by CONTENT, not by line number: a reference change is right when all of its operations appear
 * somewhere in the plan (each one used once). Windows, 2026-11-11: qwen3:8b put the correct counter top
 * under change 2 instead of 3, which by line numbers cost it two changes for one bookkeeping slip.
 * Operations the reference doesn't have are listed as `extra`.
 */
export function scorePlan(plan: Plan, reference: Plan, lines: number[]): Score {
  const pool = new Map<string, number>();
  for (const sig of plan.actions.map(signature)) pool.set(sig, (pool.get(sig) ?? 0) + 1);
  const scores = lines.map((line) => {
    const expected = reference.actions.filter((a) => a.line === line).map(signature).sort();
    const need = new Map<string, number>();
    for (const sig of expected) need.set(sig, (need.get(sig) ?? 0) + 1);
    const missing = [...need].filter(([sig, n]) => (pool.get(sig) ?? 0) < n).map(([sig]) => sig);
    if (missing.length === 0) for (const [sig, n] of need) pool.set(sig, pool.get(sig)! - n);
    return { line, right: missing.length === 0, expected, missing };
  });
  const extra = [...pool].flatMap(([sig, n]) => Array<string>(Math.max(0, n)).fill(sig));
  return { right: scores.filter((x) => x.right).length, total: lines.length, lines: scores, extra };
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
      score: { right: 0, total: lines.length, lines: [], extra: [] },
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
    "| model | runs | changes right (avg) | extra actions (avg) | runnable plans | avg time | failures |",
    "|---|---|---|---|---|---|---|",
  ];
  for (const m of models) {
    const rs = runs.filter((r) => r.model === m);
    const avg = rs.reduce((n, r) => n + r.score.right, 0) / rs.length;
    const runnable = rs.filter((r) => !r.failure && r.errors.length === 0).length;
    const secs = Math.round(rs.reduce((n, r) => n + r.seconds, 0) / rs.length);
    const extra = rs.reduce((n, r) => n + r.score.extra.length, 0) / rs.length;
    out.push(`| ${m} | ${rs.length} | ${avg.toFixed(1)} / ${rs[0]!.score.total} | ${extra.toFixed(1)} | ${runnable} / ${rs.length} | ${secs} s | ${rs.filter((r) => r.failure).length} |`);
  }
  out.push("", "Changes that were wrong (model, run: lines):");
  for (const r of runs) {
    const wrong = r.score.lines.filter((l) => !l.right).map((l) => l.line);
    out.push(`- ${r.model}, run ${r.run}: ${r.failure ? `FAILED (${r.failure.split("\n")[0]})` : wrong.length ? wrong.join(", ") : "none"}${r.errors.length ? ` · ${r.errors.length} plan errors` : ""}${r.score.extra.length ? ` · extra: ${r.score.extra.join("; ")}` : ""}`);
    for (const l of r.score.lines.filter((x) => !x.right)) out.push(`  - change ${l.line} missing: ${l.missing.join("; ")}`);
  }
  return out.join("\n");
}
