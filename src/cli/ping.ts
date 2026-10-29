// npm run ping: the quickest "is SketchUp listening?" check.
import { BridgeClient } from "../bridge/client";
import { createTransport } from "../bridge/createTransport";
import { BridgeUnavailableError } from "../bridge/transport";
import { ConfigError, loadConfig } from "../config";

async function main(): Promise<number> {
  const config = loadConfig();
  const client = new BridgeClient(createTransport(config));
  const res = await client.call("ping", {});
  if (!res.ok) {
    console.error(`ping failed: ${res.error.code}: ${res.error.message}`);
    return 1;
  }
  console.log(JSON.stringify(res.data, null, 2));
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((e: unknown) => {
    console.error(e instanceof ConfigError || e instanceof BridgeUnavailableError ? `STOPPED: ${e.message}` : e);
    process.exit(2);
  });
