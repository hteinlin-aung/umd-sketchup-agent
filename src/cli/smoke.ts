// npm run smoke        -> real SketchUp (UMD_TRANSPORT=file in .env)
// npm run smoke:mock   -> fake SketchUp, works anywhere
import { BridgeClient } from "../bridge/client";
import { createTransport } from "../bridge/createTransport";
import { BridgeUnavailableError } from "../bridge/transport";
import { ConfigError, loadConfig } from "../config";
import { runSmoke } from "../smoke/runSmoke";

async function main(): Promise<number> {
  const forceMock = process.argv.includes("--mock");
  const config = loadConfig();
  const transport = createTransport(config, forceMock);
  console.log(`UMD smoke test: ${transport.kind === "mock" ? "MOCK SketchUp (proves nothing about the real bridge)" : `real SketchUp via ${config.queueDir}`}\n`);

  const steps = await runSmoke(new BridgeClient(transport));
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
