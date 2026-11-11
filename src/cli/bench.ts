// Benchmark: plan the same brief several times with each model and score it against the reference plan.
//   npm run bench -- instructions/1F_reception.md "1F RECEPTION"                       1 run, model from .env
//   (temperature 0: Windows saw 3 runs come out identical, so more runs only help after a prompt change)
//   npm run bench -- instructions/1F_reception.md "1F RECEPTION" --runs 5 --models qwen3:8b,gpt-oss:20b
//   --reference <draft.json>   default: the brief's name with .draft.json (instructions/1F_reception.draft.json)
//   --mock                     fake room (only useful with a real Ollama, to test the command itself)
// Plans only: nothing is ever sent to SketchUp except read-only tools. Results: runs/bench_<time>/results.md
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename } from "node:path";
import { renderBench, benchOnce, type BenchRun } from "../agent/bench";
import { parseBrief } from "../agent/brief";
import { Draft } from "../agent/draft";
import { LlmError, ollamaLlm } from "../agent/llm";
import { BridgeClient } from "../bridge/client";
import { createTransport } from "../bridge/createTransport";
import { BridgeUnavailableError } from "../bridge/transport";
import { ConfigError, loadConfig } from "../config";
import { smokeRunId } from "../smoke/runSmoke";
import { findRoom, renderSummary, summarizeRoom } from "../summary/roomSummary";

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  const valued = new Set(["--runs", "--models", "--reference"]);
  const positional = args.filter((a, i) => !a.startsWith("--") && !valued.has(args[i - 1] ?? ""));
  const [briefFile, roomQuery] = positional;
  if (!briefFile || !roomQuery) {
    console.error('usage: npm run bench -- <brief.md> "<room name>" [--runs 1] [--models a,b] [--reference draft.json]');
    return 2;
  }
  const config = loadConfig();
  const runs = Number(flag(args, "--runs") ?? 1);
  const models = (flag(args, "--models") ?? config.ollamaModel).split(",").map((m) => m.trim()).filter(Boolean);
  const refFile = flag(args, "--reference") ?? briefFile.replace(/\.md$/i, ".draft.json");
  if (!existsSync(refFile)) throw new ConfigError(`no reference plan at ${refFile} (use --reference)`);
  const reference = Draft.parse(JSON.parse(readFileSync(refFile, "utf8")));
  const brief = parseBrief(readFileSync(briefFile, "utf8"));
  const runId = smokeRunId();
  const opts = { runId, briefName: basename(briefFile).replace(/\.md$/i, "") };
  const dir = `runs/bench_${runId}`;
  mkdirSync(dir, { recursive: true });

  const client = new BridgeClient(createTransport(config, args.includes("--mock"), { scene: "reception" }));
  const room = await findRoom(client, roomQuery);
  const summary = await summarizeRoom(client, { persistentId: room.persistentId });
  const summaryText = renderSummary(summary);
  writeFileSync(`${dir}/summary.md`, summaryText + "\n");
  console.log(`room read: ${summary.items.length} items. ${models.length} model(s) x ${runs} runs, ${brief.changes.length} changes each.\n`);

  const results: BenchRun[] = [];
  for (const model of models) {
    const llm = ollamaLlm(config.ollamaUrl, model);
    for (let run = 1; run <= runs; run++) {
      const r = await benchOnce(llm, model, run, brief, summary, summaryText, reference, opts);
      results.push(r);
      if (r.draft) writeFileSync(`${dir}/${model.replace(/[^\w.-]+/g, "_")}_run${run}.draft.json`, JSON.stringify(r.draft, null, 2));
      console.log(
        `${model} run ${run}: ${r.failure ? `FAILED: ${r.failure.split("\n")[0]}` : `${r.score.right}/${r.score.total} changes right, ${r.errors.length} errors, ${r.warnings} warnings`}, ${r.seconds} s`,
      );
    }
  }

  const table = renderBench(results);
  writeFileSync(`${dir}/results.md`, `# Benchmark ${runId}\n\nBrief: ${briefFile} · reference: ${refFile}\n\n${table}\n`);
  writeFileSync(`${dir}/results.json`, JSON.stringify(results.map(({ draft: _d, ...r }) => r), null, 2));
  console.log(`\n${table}\n\nSaved in ${dir}/`);
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((e: unknown) => {
    if (e instanceof BridgeUnavailableError || e instanceof ConfigError || e instanceof LlmError) console.error(`STOPPED: ${e.message}`);
    else console.error(e);
    process.exit(1);
  });
