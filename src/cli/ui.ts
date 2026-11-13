// The local page for the agent.
//   npm run ui                 then open http://127.0.0.1:4477 in a browser
//   npm run ui -- --port 5000  another port
// The page starts the same `npm run agent` command you would type, shows each line live, and turns
// its questions into buttons. See src/ui/server.ts.
import { join } from "node:path";
import { ConfigError, loadConfig } from "../config";
import { createUiServer } from "../ui/server";

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  const i = args.indexOf("--port");
  const port = i >= 0 ? Number(args[i + 1]) : 4477;
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    console.error("usage: npm run ui [-- --port 4477]   (a port from 1024 to 65535)");
    return 2;
  }
  const config = loadConfig();
  const root = process.cwd();
  const ui = createUiServer({
    root,
    imageRoots: [join(root, "runs"), ...(config.queueDir ? [config.queueDir] : [])],
    info: { transport: config.transport, model: config.ollamaModel },
  });
  try {
    await ui.listen(port);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    console.error(code === "EADDRINUSE" ? `Port ${port} is in use. Is the page already running? Or try: npm run ui -- --port ${port + 1}` : String(e));
    return 1;
  }
  console.log(`The agent page is at http://127.0.0.1:${port}  (only reachable from this computer)`);
  console.log(config.transport === "mock" ? "No .env here, so runs use the fake SketchUp." : `Real SketchUp through ${config.queueDir}`);
  console.log("Keep this window open. Press Ctrl+C to stop the page.");
  return await new Promise<number>(() => {});
}

main()
  .then((code) => process.exit(code))
  .catch((e: unknown) => {
    console.error(e instanceof ConfigError ? e.message : e);
    process.exit(1);
  });
