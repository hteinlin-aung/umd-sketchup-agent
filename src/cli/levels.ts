// npm run levels                      -> probe a 3 x 3 grid inside each UMD 1F/2F/3F group
// npm run levels -- --at 12.5,7 --at 40,10   -> probe your own x,y points (metres)
// Read-only: works on any open model, including the MASTER.
import { mkdirSync, writeFileSync } from "node:fs";
import { BridgeClient } from "../bridge/client";
import { createTransport } from "../bridge/createTransport";
import { BridgeUnavailableError } from "../bridge/transport";
import { ConfigError, loadConfig } from "../config";
import { readLevels, summarizeFloors, type Probe } from "../levels/readLevels";

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

  if (results.length > 0 && !results.some((r) => /^UMD [1-9]F @/i.test(r.label))) {
    console.log('\nNOTE: no "UMD 1F/2F/3F" groups in this model, so the probes went through the top-level groups instead.');
  }
  if (results.length > 0 && results.every((r) => r.hits.length === 0)) {
    console.log("NOTE: no probe hit any surface. Is this the right model? (Run `npm run ping` to see which file is open.)");
  }
  const floors = summarizeFloors(results);
  console.log(`\nFloor-like surfaces found by ${results.length} probes (highest first):`);
  console.log("      z (m)   probes   example");
  for (const f of floors) console.log(`  ${f.z.toFixed(3).padStart(9)}   ${String(f.probes).padStart(6)}   ${f.example}`);

  // Full detail for the most informative probe of each group (the one that hit the most surfaces).
  const best = new Map<string, (typeof results)[number]>();
  for (const r of results) {
    const group = r.label.split(" @")[0]!;
    if (!best.has(group) || r.hits.length > best.get(group)!.hits.length) best.set(group, r);
  }
  for (const r of best.values()) {
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
