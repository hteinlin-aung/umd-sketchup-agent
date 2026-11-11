// Step 2c: brief -> AI draft -> checked plan -> you approve -> SketchUp -> saved copy + report.
//   npm run agent -- instructions/1F_reception.md "1F RECEPTION"           ask the local model (Ollama)
//   npm run agent -- instructions/1F_reception.md "1F RECEPTION" --dry     plan only, nothing runs
//   npm run agent -- <brief> "<room>" --draft instructions/1F_reception.draft.json   skip the model, use a hand-written draft
//   add --mock to use the fake reception room instead of SketchUp
// The model is asked about ONE numbered change at a time (see src/agent/planner.ts).
// Everything is saved in runs/agent_<time>/ (summary, the model's answers, draft, plan, report).
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename } from "node:path";
import { createInterface } from "node:readline/promises";
import { executePlan, renderReport } from "../agent/execute";
import { Draft } from "../agent/draft";
import { LlmError, ollamaLlm } from "../agent/llm";
import { parseBrief } from "../agent/brief";
import { planBrief } from "../agent/planner";
import { renderPlan, resolveDraft } from "../agent/resolve";
import { BridgeClient } from "../bridge/client";
import { createTransport } from "../bridge/createTransport";
import { BridgeUnavailableError } from "../bridge/transport";
import { ConfigError, loadConfig } from "../config";
import { smokeRunId } from "../smoke/runSmoke";
import { checkAndRepair, verifyRun } from "../geometry/checks";
import { findRoom, renderSummary, summarizeRoom } from "../summary/roomSummary";

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  const draftFile = flag(args, "--draft");
  const positional = args.filter((a, i) => !a.startsWith("--") && args[i - 1] !== "--draft");
  const [briefFile, roomQuery] = positional;
  if (!briefFile || !roomQuery) {
    console.error('usage: npm run agent -- <brief.md> "<room name>" [--dry] [--draft draft.json] [--mock]');
    return 2;
  }
  let dry = args.includes("--dry");
  const config = loadConfig();
  const client = new BridgeClient(createTransport(config, args.includes("--mock"), { scene: "reception" }));
  const runId = smokeRunId();
  const briefName = basename(briefFile).replace(/\.md$/i, "");
  const dir = `runs/agent_${runId}`;
  mkdirSync(dir, { recursive: true });
  const brief = parseBrief(readFileSync(briefFile, "utf8"));
  if (brief.changes.length === 0) throw new ConfigError(`${briefFile} has no numbered changes ("1. ...", "2. ...")`);

  const ping = await client.call("ping", {});
  if (!ping.ok) throw new Error(`ping failed: ${ping.error.code}`);
  console.log(`model open: ${ping.data.modelTitle}`);
  if (/master/i.test(ping.data.modelTitle)) {
    console.log("This looks like the MASTER: planning only, nothing will run (and the bridge would refuse anyway).");
    dry = true;
  }

  console.log(`reading the room "${roomQuery}" ...`);
  const room = await findRoom(client, roomQuery);
  const summary = await summarizeRoom(client, { persistentId: room.persistentId });
  const summaryText = renderSummary(summary);
  writeFileSync(`${dir}/summary.md`, summaryText + "\n");
  console.log(`  ${summary.items.length} items, floor z ${summary.floor.z}`);

  const resolve = (d: Draft) => resolveDraft(d, summary, { runId, briefName });
  let draft: Draft;
  let modelName = "(hand-written draft)";
  if (draftFile) {
    draft = Draft.parse(JSON.parse(readFileSync(draftFile, "utf8")));
    console.log(`using the draft in ${draftFile} (no language model)`);
  } else {
    modelName = config.ollamaModel;
    console.log(`asking ${modelName} to plan ${brief.changes.length} changes, one at a time (on this PC) ...`);
    const started = Date.now();
    const out = await planBrief(ollamaLlm(config.ollamaUrl, config.ollamaModel), brief, summary, summaryText, { runId, briefName }, (o) =>
      console.log(
        `  change ${o.line}: ${o.type === "failed" ? `FAILED after ${o.tries} tries (${o.problems[0]})` : o.type === "steps" ? `${o.steps} step${o.steps === 1 ? "" : "s"}` : o.type}` +
          `${o.tries > 1 && o.type !== "failed" ? " (2nd try)" : ""}, ${o.seconds} s`,
      ),
    );
    writeFileSync(`${dir}/model_answers.json`, JSON.stringify(out.answers, null, 2));
    writeFileSync(`${dir}/outcomes.json`, JSON.stringify(out.outcomes, null, 2));
    console.log(`  all changes planned in ${((Date.now() - started) / 1000).toFixed(0)} s`);
    draft = out.draft;
  }
  writeFileSync(`${dir}/draft.json`, JSON.stringify(draft, null, 2));

  // Week 3: check every new block against the real parts of the model; slide it clear where possible.
  console.log("checking new blocks against the real model ...");
  const checked = await checkAndRepair(client, draft, summary, resolve);
  const plan = checked.plan;
  const checks: string[] = [];
  for (const r of checked.repairs) checks.push(`MOVED ${r.step} (brief line ${r.line}) ${r.moved} m ${r.direction}: ${r.because}`);
  for (const c of checked.unresolved) checks.push(`NOT FIXED ${c.step}: collides with "${c.with}" (${c.path.join(" > ")})`);
  if (checks.length === 0) checks.push("no new block cuts into any real part of the model");
  if (checked.repairs.length) writeFileSync(`${dir}/draft.repaired.json`, JSON.stringify(checked.draft, null, 2));
  writeFileSync(`${dir}/plan.json`, JSON.stringify(plan, null, 2));
  console.log(`\n${renderPlan(plan)}\n\nGEOMETRY CHECKS:\n${checks.map((c) => `  ${c}`).join("\n")}\n`);

  const report = (run: Parameters<typeof renderReport>[0]["run"]) =>
    writeFileSync(`${dir}/report.md`, renderReport({ brief: brief.text, summaryText, plan, run, model: modelName, checks }));

  if (plan.errors.length) {
    report(null);
    console.log(`The plan has errors, so nothing ran. Everything is in ${dir}/`);
    return 1;
  }
  if (dry) {
    report(null);
    console.log(`Plan only (--dry). Everything is in ${dir}/`);
    return 0;
  }

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question(`Run these ${plan.actions.length} actions on ${ping.data.modelTitle}? Type y to run, anything else to stop: `);
  rl.close();
  if (answer.trim().toLowerCase() !== "y") {
    report(null);
    console.log(`Stopped, nothing changed. The plan is in ${dir}/`);
    return 0;
  }

  const run = await executePlan(
    client,
    plan,
    (r) => console.log(`${r.ok ? "  ok " : "  FAILED"} [${r.n}] ${r.message} (${r.durationMs} ms)`),
    async (built) => {
      // Read everything back before saving: new blocks in place, nothing else in the room changed.
      const after = await summarizeRoom(client, { persistentId: room.persistentId });
      const v = await verifyRun(client, plan, summary, after, built);
      checks.push(...v.lines.map((l) => `read-back: ${l}`));
      console.log(`read-back before saving:\n${v.lines.map((l) => `  ${l}`).join("\n")}`);
      return v.ok;
    },
  );
  report(run);
  console.log(
    run.stoppedAt === null
      ? `\nDone. Saved copy: ${run.savedPath}\nReport: ${dir}/report.md`
      : `\nStopped at action ${run.stoppedAt}. The open model has the earlier changes; close it WITHOUT saving.\nReport: ${dir}/report.md`,
  );
  return run.stoppedAt === null ? 0 : 1;
}

main()
  .then((code) => process.exit(code))
  .catch((e: unknown) => {
    if (e instanceof BridgeUnavailableError || e instanceof ConfigError || e instanceof LlmError) {
      console.error(`STOPPED: ${e.message}`);
    } else {
      console.error(e);
    }
    process.exit(1);
  });
