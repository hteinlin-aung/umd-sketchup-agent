// npm run smoke        -> real SketchUp (UMD_TRANSPORT=file in .env)
// npm run smoke:mock   -> fake SketchUp, works anywhere
// npm run smoke:w2     -> Week 2 changing tools (createPrism, setTag, setTagVisibility, moveToReplaced)
import { BridgeClient } from "../bridge/client";
import { createTransport } from "../bridge/createTransport";
import { BridgeUnavailableError } from "../bridge/transport";
import { ConfigError, loadConfig } from "../config";
import { runSmoke, smokeRunId } from "../smoke/runSmoke";
import { runWeek2 } from "../smoke/runWeek2";

async function main(): Promise<number> {
  const forceMock = process.argv.includes("--mock");
  const config = loadConfig();
  const transport = createTransport(config, forceMock);
  console.log(`UMD smoke test: ${transport.kind === "mock" ? "MOCK SketchUp (proves nothing about the real bridge)" : `real SketchUp via ${config.queueDir}`}\n`);

  const week2 = process.argv.includes("--week2");
  const client = new BridgeClient(transport);
  const steps = week2 ? await runWeek2(client, smokeRunId()) : await runSmoke(client);
  for (const s of steps) console.log(`${s.pass ? "PASS" : "FAIL"}  ${s.step.padEnd(18)} ${s.detail}`);

  const failed = steps.filter((s) => !s.pass).length;
  console.log(`\n${steps.length - failed}/${steps.length} passed`);
  return failed === 0 ? 0 : 1;
}

main()
  .then((code) => process.exit(code))
  .catch((e: unknown) => {
    if (e instanceof ConfigError || e instanceof BridgeUnavailableError) {
      console.error(`\nSTOPPED: ${e.message}`);
    } else {
      console.error(e);
    }
    process.exit(2);
  });
