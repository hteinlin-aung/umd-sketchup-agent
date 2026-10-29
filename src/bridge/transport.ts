import type { Command, Result } from "../protocol/envelope";

/**
 * A Transport delivers one command to SketchUp and returns its result.
 * Two implementations:
 *   - FileQueueTransport: the real one (JSON files in a folder SketchUp watches)
 *   - MockSketchUp:       an in-memory fake for tests on the Mac
 * The rest of the app only knows this interface, so the two can be swapped.
 */
export interface Transport {
  readonly kind: "file" | "mock";
  send(command: Command): Promise<Result>;
}

/** SketchUp could not be reached, or did not answer in time. Not a tool failure. */
export class BridgeUnavailableError extends Error {
  constructor(
    message: string,
    readonly reason: "NO_HEARTBEAT" | "NOT_PICKED_UP" | "STILL_RUNNING" | "BAD_RESULT_FILE",
  ) {
    super(message);
    this.name = "BridgeUnavailableError";
  }
}
