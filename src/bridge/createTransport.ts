import type { Config } from "../config";
import { FileQueueTransport } from "./fileQueue";
import { MockSketchUp } from "./mockSketchUp";
import type { Transport } from "./transport";

export function createTransport(config: Config, forceMock = false): Transport {
  if (forceMock || config.transport === "mock") return new MockSketchUp();
  return new FileQueueTransport({
    queueDir: config.queueDir!, // parseConfig guarantees it is set for "file"
    timeoutMs: config.commandTimeoutMs,
    pollMs: config.pollMs,
  });
}
