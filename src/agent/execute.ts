import type { BridgeClient } from "../bridge/client";
import type { ToolName } from "../protocol/tools";
import { renderPlan, type Plan } from "./resolve";

/**
 * Step 2c: runs an APPROVED plan, one action at a time, and stops at the first failure.
 * Each tool is its own undo step in SketchUp. The open model is never saved; the plan
 * ends with saveCopy, so the result is a new file.
 */

export type ActionResult = { n: number; ok: boolean; message: string; durationMs: number };

export type RunResult = {
  results: ActionResult[];
  stoppedAt: number | null; // the action that failed, or null if all ran
  savedPath: string | null;
  imagePath: string | null; // the first picture
  imagePaths: string[]; // every picture, in order
  built: Record<string, number>; // step id -> entityId of the new block
};

export async function executePlan(
  client: BridgeClient,
  plan: Plan,
  onResult: (r: ActionResult) => void = () => {},
  /** Called just before the save with the new blocks; return false to stop WITHOUT saving (e.g. a failed read-back). */
  beforeSave: (built: Record<string, number>) => Promise<boolean> = async () => true,
): Promise<RunResult> {
  if (plan.errors.length) throw new Error("this plan has errors and must not run");
  const built = new Map<string, number>(); // step id -> entityId
  const results: ActionResult[] = [];
  let savedPath: string | null = null;
  const imagePaths: string[] = [];
  const done = (stoppedAt: number | null): RunResult => ({ results, stoppedAt, savedPath, imagePath: imagePaths[0] ?? null, imagePaths, built: Object.fromEntries(built) });

  for (const a of plan.actions) {
    let args = a.args;
    if (a.targetsStep) {
      const id = built.get(a.targetsStep);
      if (id === undefined) {
        const r = { n: a.n, ok: false, message: `${a.targetsStep} was not built`, durationMs: 0 };
        results.push(r);
        onResult(r);
        return done(a.n);
      }
      args = { ...args, target: { entityId: id } };
    }

    if (a.tool === "saveCopy" && !(await beforeSave(Object.fromEntries(built)))) {
      const r = { n: a.n, ok: false, message: "not saved: the read-back check failed (see the report)", durationMs: 0 };
      results.push(r);
      onResult(r);
      return done(a.n);
    }
    const started = Date.now();
    const res = await client.call(a.tool as ToolName, args as never);
    const durationMs = Date.now() - started;
    if (!res.ok) {
      const r = { n: a.n, ok: false, message: `${res.error.code}: ${res.error.message}`, durationMs };
      results.push(r);
      onResult(r);
      return done(a.n);
    }

    const data = res.data as Record<string, unknown>;
    let message = "ok";
    if (a.builds && typeof data.entityId === "number") {
      built.set(a.builds, data.entityId);
      const wb = data.worldBounds as { min: number[]; max: number[] } | undefined;
      const vol = typeof data.volumeM3 === "number" ? `, volume ${data.volumeM3.toFixed(4)} m³` : "";
      const what = a.tool === "placeComponent" ? `placed ${String(data.definitionName)}` : "built";
      message = wb ? `${what}, measured ${wb.min.map((v, i) => (wb.max[i]! - v).toFixed(3)).join(" x ")} m${vol}` : what;
    } else if (a.tool === "applyMaterial") {
      message = `${data.facesChecked} faces painted${data.created ? " (material created)" : ""}`;
    } else if (a.tool === "moveToReplaced") {
      message = `now on "${data.tag}"`;
    } else if (a.tool === "saveCopy") {
      savedPath = String(data.path);
      message = `saved ${savedPath} (${data.bytes} bytes)`;
    } else if (a.tool === "addScene") {
      message = `scene "${String(data.name)}"${data.renamed ? " (the name was taken)" : ""}, ${data.sceneCount} scenes in the model`;
    } else if (a.tool === "captureView") {
      imagePaths.push(String(data.path));
      message = `image ${String(data.path)}`;
    }
    const r = { n: a.n, ok: true, message, durationMs };
    results.push(r);
    onResult(r);
  }
  return done(null);
}

/** The report saved next to the plan: what was asked, what was approved, what happened. */
export function renderReport(opts: { brief: string; summaryText: string; plan: Plan; run: RunResult | null; model: string; checks?: string[] }): string {
  const { plan, run } = opts;
  const out = [`# Agent run ${plan.runId}`, "", `- model file: ${plan.modelPath}`, `- language model: ${opts.model}`];
  if (!run) out.push("- result: **not run** (plan only)");
  else if (run.stoppedAt === null) out.push(`- result: **all ${run.results.length} actions ran**`);
  else out.push(`- result: **stopped at action ${run.stoppedAt}**; the actions before it are in the open model (not saved)`);
  if (run?.savedPath) out.push(`- saved copy: ${run.savedPath}`);
  for (const p of run?.imagePaths ?? []) out.push(`- screenshot: ${p}`);
  out.push("", "## Plan (as approved)", "", "```", renderPlan(plan), "```");
  if (opts.checks?.length) out.push("", "## Geometry checks", "", ...opts.checks.map((c) => `- ${c}`));
  if (run) {
    out.push("", "## What happened", "", "| # | ok | time | result |", "|---|---|---|---|");
    for (const r of run.results) out.push(`| ${r.n} | ${r.ok ? "yes" : "**NO**"} | ${r.durationMs} ms | ${r.message.replace(/\|/g, "/").replace(/\n/g, " ")} |`);
  }
  out.push("", "## Brief", "", opts.brief.trim(), "", "## Room summary the model saw", "", "```", opts.summaryText, "```", "");
  return out.join("\n");
}
