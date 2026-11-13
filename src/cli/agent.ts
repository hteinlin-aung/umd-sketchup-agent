// Step 2c: brief -> AI draft -> checked plan -> you approve -> SketchUp -> saved copy + report.
//   npm run agent -- instructions/1F_reception.md "1F RECEPTION"           ask the local model (Ollama)
//   npm run agent -- instructions/1F_reception.md "1F RECEPTION" --dry     plan only, nothing runs
//   npm run agent -- <brief> "<room>" --draft instructions/1F_reception.draft.json   skip the model, use a hand-written draft
//   add --mock to use the fake reception room instead of SketchUp
//   add --warm to keep the model loaded (by default it starts cold, like the benchmark)
// The model is asked about ONE numbered change at a time (see src/agent/planner.ts).
// Everything is saved in runs/agent_<time>/ (summary, the model's answers, draft, plan, report).
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename } from "node:path";
import { AS_DRAWN_LIST, catalogCache, loadCatalog } from "../agent/catalog";
import { chooseComponents } from "../agent/choose";
import { executePlan, renderReport } from "../agent/execute";
import { Draft } from "../agent/draft";
import { LlmError, ollamaLlm, ollamaUnload } from "../agent/llm";
import { parseBrief } from "../agent/brief";
import { briefRules, planBrief } from "../agent/planner";
import { renderPlan, resolveDraft } from "../agent/resolve";
import { BridgeClient } from "../bridge/client";
import { createTransport } from "../bridge/createTransport";
import { BridgeUnavailableError } from "../bridge/transport";
import { ConfigError, loadConfig } from "../config";
import { smokeRunId } from "../smoke/runSmoke";
import { checkAndRepair, verifyRun } from "../geometry/checks";
import { checkViews, floorUnderRoom } from "../geometry/views";
import { runOutcome, type OutcomeInput } from "../agent/outcome";
import { terminal } from "./terminal";
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

  // Your components (real 3D Warehouse pieces) with their sizes, so "place" steps can be planned.
  const mock = args.includes("--mock");
  const { catalog, problems: catalogProblems } = await loadCatalog(client, {
    canMeasure: !dry && !/master/i.test(ping.data.modelTitle),
    cachePath: catalogCache(mock),
    asDrawnPath: mock ? undefined : AS_DRAWN_LIST,
    onMeasure: (file, i, n) => console.log(`  measuring component ${i}/${n}: ${file}`),
  });
  console.log(`  ${catalog.size} components available${catalogProblems.length ? ` (${catalogProblems.length} not usable, see: npm run components)` : ""}`);
  const resolve = (d: Draft) => resolveDraft(d, summary, { runId, briefName, catalog });
  let draft: Draft;
  let modelName = "(hand-written draft)";
  const modelGaveUp: OutcomeInput["modelGaveUp"] = [];
  if (draftFile) {
    draft = Draft.parse(JSON.parse(readFileSync(draftFile, "utf8")));
    console.log(`using the draft in ${draftFile} (no language model)`);
  } else {
    modelName = config.ollamaModel;
    console.log(`asking ${modelName} to plan ${brief.changes.length} changes, one at a time (on this PC) ...`);
    const started = Date.now();
    // Start cold, the same condition the benchmark measures (Ollama's prompt cache changes answers). --warm skips it.
    if (!args.includes("--warm")) await ollamaUnload(config.ollamaUrl, config.ollamaModel);
    const out = await planBrief(ollamaLlm(config.ollamaUrl, config.ollamaModel), brief, summary, summaryText, { runId, briefName, catalog }, (o) =>
      console.log(
        `  change ${o.line}: ${o.type === "failed" ? `FAILED after ${o.tries} tries (${o.problems[0]})` : o.type === "steps" ? `${o.steps} step${o.steps === 1 ? "" : "s"}` : o.type}` +
          `${o.tries > 1 && o.type !== "failed" ? " (2nd try)" : ""}, ${o.seconds} s`,
      ),
    );
    writeFileSync(`${dir}/model_answers.json`, JSON.stringify(out.answers, null, 2));
    writeFileSync(`${dir}/outcomes.json`, JSON.stringify(out.outcomes, null, 2));
    console.log(`  all changes planned in ${((Date.now() - started) / 1000).toFixed(0)} s`);
    draft = out.draft;
    for (const o of out.outcomes) if (o.type === "failed") modelGaveUp.push({ line: o.line, reason: o.problems[0] ?? "no usable answer" });
  }
  writeFileSync(`${dir}/draft.json`, JSON.stringify(draft, null, 2));

  // "Which one do you like?" The designer picks every component (the agent's pick is option 1).
  // With --dry the choices are only listed.
  const rl = terminal();
  const ask = rl.ask;
  const chosenLines: string[] = [];
  if (draft.steps.some((st) => st.op === "place")) {
    console.log("");
    const chosen = await chooseComponents(client, draft, catalog, dry ? null : ask);
    draft = chosen.draft;
    if (chosen.choices.length) {
      writeFileSync(`${dir}/choices.json`, JSON.stringify(chosen.choices, null, 2));
      for (const c of chosen.choices) {
        chosenLines.push(
          `CHOSEN ${c.step} (brief line ${c.line}): ${c.picked}  (from ${c.from.join(", ")})${c.renamed ? `; renamed "${c.renamed.from}" -> "${c.renamed.to}"` : ""}`,
        );
      }
      writeFileSync(`${dir}/draft.json`, JSON.stringify(draft, null, 2));
    }
  }

  // Week 3: check every new block against the real parts of the model; slide it clear where possible.
  console.log("checking new blocks against the real model ...");
  const checked = await checkAndRepair(client, draft, summary, resolve, briefRules(brief));
  const plan = checked.plan;
  const checks: string[] = [...chosenLines];
  for (const r of checked.repairs) checks.push(`MOVED ${r.step} (brief line ${r.line}) ${r.moved} m ${r.direction}: ${r.because}`);
  for (const c of checked.unresolved) checks.push(`NOT FIXED ${c.step}: collides with "${c.with}" (${c.path.join(" > ")})`);
  if (checked.repairs.length === 0 && checked.unresolved.length === 0) checks.push("no new block cuts into any real part of the model");
  // A trimmed copy with only the room in it has no building to collide with: say so instead of "nothing hit".
  const hasFloor = await floorUnderRoom(client, summary);
  if (!hasFloor) {
    checks.push(
      "WARNING: this model has no floor under the room - it looks like a trimmed copy with the room group only - so walls, columns and floors " +
        "outside the room group could NOT be checked. Use a full 1F dev copy to check against the building.",
    );
  }
  // Where each screenshot stands, now that the blocks are where they will be (after any slide).
  if (!plan.errors.length) checks.push(...(await checkViews(client, plan, hasFloor)));
  if (checked.repairs.length) writeFileSync(`${dir}/draft.repaired.json`, JSON.stringify(checked.draft, null, 2));
  writeFileSync(`${dir}/plan.json`, JSON.stringify(plan, null, 2));
  console.log(`\n${renderPlan(plan)}\n\nGEOMETRY CHECKS:\n${checks.map((c) => `  ${c}`).join("\n")}\n`);

  // Week 3 "done when": every way out of here writes ONE clear outcome, first thing in report.md.
  const moved = checked.repairs.map((r) => `${r.step} ${r.moved} m ${r.direction} (brief line ${r.line})`);
  const finish = (run: Parameters<typeof renderReport>[0]["run"], how: { declined?: boolean } = {}) => {
    const notChecked = hasFloor ? [] : ["this model has no building around the room (no floor under it), so walls and columns were not checked"];
    const outcome = runOutcome({ planErrors: plan.errors, repairsExhausted: checked.exhausted, moved, modelGaveUp, notChecked, dry, declined: !!how.declined, run });
    writeFileSync(`${dir}/report.md`, renderReport({ brief: brief.text, summaryText, plan, run, model: modelName, checks, outcome }));
    console.log(`\nOUTCOME: ${outcome.outcome}\n${outcome.why.map((w) => `  - ${w}`).join("\n")}`);
    return outcome.outcome;
  };

  if (plan.errors.length) {
    rl.close();
    finish(null);
    console.log(`The plan has errors, so nothing ran. Everything is in ${dir}/`);
    return 1;
  }
  if (dry) {
    rl.close();
    finish(null);
    console.log(`Plan only (--dry). Everything is in ${dir}/`);
    return 0;
  }

  const moves = checked.repairs.length
    ? ` NOTE: ${checked.repairs.length} automatic move${checked.repairs.length > 1 ? "s" : ""} changed your design (see GEOMETRY CHECKS).`
    : "";
  const answer = await rl.ask(`Run these ${plan.actions.length} actions on ${ping.data.modelTitle}?${moves} Type y to run, anything else to stop: `);
  rl.close();
  if (answer.trim().toLowerCase() !== "y") {
    finish(null, { declined: true });
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
  const outcome = finish(run);
  console.log(
    run.stoppedAt === null
      ? `\nDone. Saved copy: ${run.savedPath}\nReport: ${dir}/report.md`
      : `\nStopped at action ${run.stoppedAt}. The open model has the earlier changes; close it WITHOUT saving.\nReport: ${dir}/report.md`,
  );
  return outcome === "SUCCESS" ? 0 : 1;
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
