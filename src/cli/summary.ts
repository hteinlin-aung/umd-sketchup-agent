// npm run summary -- "1F RECEPTION"          -> describe that room (read-only, works on any model)
// npm run summary -- "1F RECEPTION" --mock   -> same, on the fake reception room
// npm run summary                            -> list the top-level groups to choose from
// Writes runs/summary_<time>.md (what the AI will read) and .json (the refs -> ids).
import { mkdirSync, writeFileSync } from "node:fs";
import { BridgeClient } from "../bridge/client";
import { createTransport } from "../bridge/createTransport";
import { BridgeUnavailableError } from "../bridge/transport";
import { ConfigError, loadConfig } from "../config";
import { smokeRunId } from "../smoke/runSmoke";
import { renderSummary, summarizeRoom } from "../summary/roomSummary";

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  const mock = args.includes("--mock");
  const query = args.find((a) => !a.startsWith("--"));
  const client = new BridgeClient(createTransport(loadConfig(), mock, { scene: "reception" }));

  if (!query) {
    const info = await client.call("getModelInfo", { maxItems: 200 });
    if (!info.ok) throw new Error(`${info.error.code}: ${info.error.message}`);
    console.log('usage: npm run summary -- "<part of the room name>"\n\nTop-level groups in this model:');
    for (const e of info.data.topLevel) console.log(`  ${e.name || e.definitionName}`);
    return 2;
  }

  const found = await client.call("findEntities", { name: query, maxDepth: 3, limit: 20 });
  if (!found.ok) throw new Error(`${found.error.code}: ${found.error.message}`);
  const best = Math.min(...found.data.matches.map((m) => m.depth));
  const rooms = found.data.matches.filter((m) => m.depth === best);
  if (rooms.length !== 1) {
    console.error(rooms.length === 0 ? `nothing called "${query}"` : `"${query}" matches ${rooms.length} things, be more specific:`);
    for (const r of rooms) console.error(`  ${r.path.join(" > ")}`);
    return 1;
  }

  const started = Date.now();
  const summary = await summarizeRoom(client, { persistentId: rooms[0]!.persistentId });
  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  const text = renderSummary(summary);
  console.log(text);

  mkdirSync("runs", { recursive: true });
  const base = `runs/summary_${smokeRunId()}`;
  writeFileSync(`${base}.md`, text + "\n");
  writeFileSync(`${base}.json`, JSON.stringify(summary, null, 2));
  console.log(`\nbuilt in ${seconds} s, ${text.length} characters (~${Math.round(text.length / 4)} tokens)`);
  console.log(`saved ${base}.md and ${base}.json`);
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((e: unknown) => {
    if (e instanceof BridgeUnavailableError || e instanceof ConfigError) {
      console.error(e.message);
      process.exit(1);
    }
    console.error(e);
    process.exit(1);
  });
