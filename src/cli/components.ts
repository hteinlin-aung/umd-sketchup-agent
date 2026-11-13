// npm run components          -> list the components folder with each component's real size (cached)
// npm run components --mock   -> the same on the fake folder
// Measuring loads each new file into SketchUp for a moment and removes it again, so it needs a DEV model
// open (not the MASTER). Sizes are cached in runs/components.json; only new or changed files are measured.
import { AS_DRAWN_LIST, catalogCache, fitComponent, fitProblem, loadCatalog, plausibility } from "../agent/catalog";
import { BridgeClient } from "../bridge/client";
import { createTransport } from "../bridge/createTransport";
import { BridgeUnavailableError } from "../bridge/transport";
import { ConfigError, loadConfig } from "../config";

async function main(): Promise<number> {
  const mock = process.argv.includes("--mock");
  const client = new BridgeClient(createTransport(loadConfig(), mock, { scene: "reception" }));
  const ping = await client.call("ping", {});
  if (!ping.ok) throw new Error(`ping failed: ${ping.error.code}`);
  const onMaster = /master/i.test(ping.data.modelTitle);
  if (onMaster) console.log("The MASTER is open: only cached sizes are shown. Open a dev model to measure new files.\n");

  const started = Date.now();
  const { catalog, problems } = await loadCatalog(client, {
    canMeasure: !onMaster,
    cachePath: catalogCache(mock),
    asDrawnPath: mock ? undefined : AS_DRAWN_LIST,
    onMeasure: (file, i, n) => console.log(`measuring ${i}/${n}: ${file}`),
  });
  console.log(`\n${catalog.size} components (${((Date.now() - started) / 1000).toFixed(0)} s):`);
  console.log("   east-west x north-south x height (m)   MB    file");
  for (const c of [...catalog.values()].sort((a, b) => a.file.localeCompare(b.file))) {
    const size = c.size.map((v) => v.toFixed(2)).join(" x ");
    console.log(`   ${size.padEnd(36)}${(c.bytes / 1e6).toFixed(1).padStart(5)}    ${c.file}`);
  }
  for (const p of problems) console.log(`NOT USABLE: ${p}`);
  for (const c of [...catalog.values()].filter((x) => x.asDrawn)) console.log(`RIGHT AS DRAWN (your list): ${c.file}`);
  const flagged = [...catalog.values()].filter((c) => plausibility(c.file, c.size, { asDrawn: c.asDrawn }));
  for (const c of flagged) {
    const fixed = fitComponent(c.file, c.size, { asDrawn: c.asDrawn });
    console.log(
      fixed
        ? `RESIZED WHEN PLACED: ${c.file}: ${plausibility(c.file, c.size)}`
        : `CAN'T BE PLACED unless the brief gives its size (or you add it to instructions/components_as_drawn.txt): ${c.file}: ${fitProblem(c.file, c.size)}`,
    );
  }
  if (flagged.length) console.log("Your files are never changed. To fix one for good: open it in SketchUp, scale it to its real size, save, run this again.");
  console.log(`\nCached in ${catalogCache(mock)}`);
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((e: unknown) => {
    if (e instanceof BridgeUnavailableError || e instanceof ConfigError) console.error(`STOPPED: ${e.message}`);
    else console.error(e);
    process.exit(1);
  });
