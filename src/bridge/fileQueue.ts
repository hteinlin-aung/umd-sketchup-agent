import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { ResultSchema, type Command, type Result } from "../protocol/envelope";
import { BridgeUnavailableError, type Transport } from "./transport";

// This implements the real file-based communication system.
//It writes commands to files and reads responses from files.

/**
 * Folder layout (must match sketchup/umd_bridge/main.rb):
 *   in/<id>.json        commands waiting       (written by us)
 *   working/<id>.json   command being run      (moved there by SketchUp)
 *   out/<id>.json       results                (written by SketchUp)
 *   cancelled/<id>.json commands we gave up on (moved there by us)
 *   heartbeat.json      SketchUp writes this every ~2 s while the bridge runs
 *
 * Both sides write to "<name>.tmp" first and then rename. A rename is atomic,
 * so neither side ever reads a half-written file.
 */
export type FileQueueOptions = {
  queueDir: string;
  timeoutMs: number;
  pollMs: number;
  heartbeatMaxAgeMs?: number; // default 10 s
};

export class FileQueueTransport implements Transport {
  readonly kind = "file" as const;
  private readonly heartbeatMaxAgeMs: number;

  constructor(private readonly opts: FileQueueOptions) {
    this.heartbeatMaxAgeMs = opts.heartbeatMaxAgeMs ?? 10_000;
  }

  private dir(name: string): string {
    return join(this.opts.queueDir, name);
  }

  /** Fails fast if SketchUp's bridge is not running, instead of waiting for the full timeout. */
  checkHeartbeat(): void {
    const file = join(this.opts.queueDir, "heartbeat.json");
    if (!existsSync(file)) {
      throw new BridgeUnavailableError(
        `No heartbeat in ${this.opts.queueDir}. Is SketchUp open with the UMD Bridge extension loaded? ` +
          "(Extensions > UMD Bridge > Start)",
        "NO_HEARTBEAT",
      );
    }
    let ageMs: number;
    try {
      const beat = JSON.parse(readFileSync(file, "utf8")) as { t?: string };
      ageMs = Date.now() - Date.parse(beat.t ?? "");
    } catch {
      ageMs = Number.POSITIVE_INFINITY;
    }
    if (!(ageMs <= this.heartbeatMaxAgeMs)) {
      throw new BridgeUnavailableError(
        `The bridge heartbeat is ${Number.isFinite(ageMs) ? Math.round(ageMs / 1000) + " s" : "unreadable/very"} old. ` +
          "SketchUp is closed, frozen, or the bridge was stopped.",
        "NO_HEARTBEAT",
      );
    }
  }

  async send(command: Command): Promise<Result> {
    this.checkHeartbeat();

    const inDir = this.dir("in");
    mkdirSync(inDir, { recursive: true });
    const inFile = join(inDir, `${command.id}.json`);
    writeFileSync(`${inFile}.tmp`, JSON.stringify(command, null, 2), "utf8");
    renameSync(`${inFile}.tmp`, inFile);

    const outFile = join(this.dir("out"), `${command.id}.json`);
    const deadline = Date.now() + this.opts.timeoutMs;

    while (Date.now() < deadline) {
      if (existsSync(outFile)) return this.readResult(outFile, command.id);
      await sleep(this.opts.pollMs);
    }
    if (existsSync(outFile)) return this.readResult(outFile, command.id);

    return this.handleTimeout(command.id, inFile);
  }

  private readResult(file: string, id: string): Result {
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(file, "utf8"));
    } catch (e) {
      throw new BridgeUnavailableError(`Result file ${file} is not valid JSON: ${(e as Error).message}`, "BAD_RESULT_FILE");
    }
    const parsed = ResultSchema.safeParse(raw);
    if (!parsed.success) {
      throw new BridgeUnavailableError(`Result file ${file} has the wrong shape: ${parsed.error.message}`, "BAD_RESULT_FILE");
    }
    if (parsed.data.id !== id) {
      throw new BridgeUnavailableError(`Result file ${file} is for command ${parsed.data.id}, expected ${id}`, "BAD_RESULT_FILE");
    }
    return parsed.data;
  }

  private handleTimeout(id: string, inFile: string): never {
    const seconds = Math.round(this.opts.timeoutMs / 1000);
    if (existsSync(inFile)) {
      // Never picked up. Move it out of in/ so SketchUp can't run it later by surprise.
      const cancelledDir = this.dir("cancelled");
      mkdirSync(cancelledDir, { recursive: true });
      try {
        renameSync(inFile, join(cancelledDir, `${id}.json`));
        throw new BridgeUnavailableError(
          `SketchUp did not pick up command ${id} within ${seconds} s. It was moved to cancelled/ and will NOT run.`,
          "NOT_PICKED_UP",
        );
      } catch (e) {
        if (e instanceof BridgeUnavailableError) throw e;
        // The rename failed because SketchUp took the file at the last moment: fall through.
      }
    }
    throw new BridgeUnavailableError(
      `SketchUp is still working on command ${id} after ${seconds} s. Do NOT resend it. ` +
        `Its result will appear in out/${id}.json when it finishes.`,
      "STILL_RUNNING",
    );
  }
}
