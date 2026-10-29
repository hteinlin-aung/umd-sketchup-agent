// npm run levels                      -> probe the centre of each UMD 1F/2F/3F group
// npm run levels -- --at 12.5,7 --at 40,10   -> probe your own x,y points (metres)
// Read-only: works on any open model, including the MASTER.
import { mkdirSync, writeFileSync } from "node:fs";
import { BridgeClient } from "../bridge/client";
import { createTransport } from "../bridge/createTransport";
import { BridgeUnavailableError } from "../bridge/transport";
import { ConfigError, loadConfig } from "../config";
import { readLevels, type Probe } from "../levels/readLevels";

function parseProbes(argv: string[]): Probe[] | undefined {
  const probes: Probe[] = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] !== "--at") continue;
    const [x, y] = (argv[i + 1] ?? "").split(",").map(Number);
    if (!Number.isFinite(x) || !Number.isFinite(y)) throw new ConfigError(`--at needs "x,y" in metres, got "${argv[i + 1]}"`);
    probes.push({ label: `at ${x},${y}`, x: x!, y: y! });
  }
  return probes.length ? probes : undefined;
}

async function main(): Promise<number> {
  const config = loadConfig();
  const client = new BridgeClient(createTransport(config, process.argv.includes("--mock")));
  const results = await readLevels(client, parseProbes(process.argv.slice(2)));

  for (const r of results) {
    console.log(`\n${r.label}  (x ${r.x}, y ${r.y})  - ${r.hits.length} surfaces, stopped: ${r.stoppedBecause}`);
    console.log("      z (m)   tag                              path");
    for (const h of r.hits) {
      const mark = h.looksLikeFloor ? "◀ floor?" : "";
      console.log(`  ${h.z.toFixed(3).padStart(9)}   ${h.tag.slice(0, 32).padEnd(32)} ${h.path.join(" > ")} ${mark}`);
    }
  }

  mkdirSync("runs", { recursive: true });
  const file = `runs/levels-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
  writeFileSync(file, JSON.stringify(results, null, 2));
  console.log(`\nRaw results saved to ${file}. Rows marked "floor?" have a floor-like group name; confirm them by eye.`);
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((e: unknown) => {
    console.error(e instanceof ConfigError || e instanceof BridgeUnavailableError ? `STOPPED: ${e.message}` : e);
    process.exit(2);
  });
