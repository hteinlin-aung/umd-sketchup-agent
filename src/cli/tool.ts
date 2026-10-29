// Run ONE tool by hand, with its arguments checked exactly as the agent would:
//   npm run tool -- findEntities '{"name":"bench"}'
//   npm run tool -- measure @probe.json        (arguments read from a JSON file)
//   npm run tool -- inspectEntity --target-id 12345
// PowerShell tip: JSON quotes get mangled when passed through npm, so prefer @file.json
// or the --target-id shortcut on Windows.
import { readFileSync } from "node:fs";
import { BridgeClient } from "../bridge/client";
import { createTransport } from "../bridge/createTransport";
import { BridgeUnavailableError } from "../bridge/transport";
import { ConfigError, loadConfig } from "../config";
import { TOOL_NAMES, isToolName } from "../protocol/tools";

function readArgs(rest: string[]): Record<string, unknown> {
  const idFlag = rest.indexOf("--target-id");
  if (idFlag >= 0) return { target: { entityId: Number(rest[idFlag + 1]) } };
  const raw = rest.find((a) => !a.startsWith("--"));
  if (!raw) return {};
  const text = raw.startsWith("@") ? readFileSync(raw.slice(1), "utf8") : raw;
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch (e) {
    throw new ConfigError(`arguments are not valid JSON (${(e as Error).message}). On Windows, put them in a file and pass @file.json`);
  }
}

async function main(): Promise<number> {
  const [tool, ...rest] = process.argv.slice(2);
  if (!tool || !isToolName(tool)) {
    console.error(`usage: npm run tool -- <tool> ['{json}' | @file.json]\ntools: ${TOOL_NAMES.join(", ")}`);
    return 2;
  }
  const client = new BridgeClient(createTransport(loadConfig(), rest.includes("--mock")));
  // The client checks the arguments with the tool's Zod schema before anything is sent.
  const res = await client.call(tool, readArgs(rest) as never);
  if (!res.ok) {
    console.error(`${tool} failed (${res.source}): ${res.error.code}\n${res.error.message}`);
    if (res.error.details) console.error(JSON.stringify(res.error.details, null, 2));
    return 1;
  }
  for (const w of res.warnings) console.warn(`warning: ${w}`);
  console.log(JSON.stringify(res.data, null, 2));
  console.error(`(${res.durationMs} ms${res.modified ? ", model changed" : ""})`);
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((e: unknown) => {
    console.error(e instanceof ConfigError || e instanceof BridgeUnavailableError ? `STOPPED: ${e.message}` : e);
    process.exit(2);
  });
