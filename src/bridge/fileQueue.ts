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
 *   heartbeat.json      SketchUp writes this every ~2 s between commands, and just
 *                       before/after each one ("busy" = which command is running)
 *
 * Both sides write to "<name>.tmp" first and then rename. A rename is atomic,
 * so neither side ever reads a half-written file.
 */
export type FileQueueOptions = {
  queueDir: string;
  timeoutMs: number;
  pollMs: number;
  heartbeatMaxAgeMs?: number; // a "not busy" heartbeat older than this is stale. Default 10 s
  heartbeatGraceMs?: number; // how long to wait for a fresh heartbeat before giving up. Default 8 s
};

type Heartbeat = { t?: string; busy?: { id?: string; since?: string } | null };

export class FileQueueTransport implements Transport {
  readonly kind = "file" as const;
  private readonly heartbeatMaxAgeMs: number;
  private readonly heartbeatGraceMs: number;

  constructor(private readonly opts: FileQueueOptions) {
    this.heartbeatMaxAgeMs = opts.heartbeatMaxAgeMs ?? 10_000;
    this.heartbeatGraceMs = opts.heartbeatGraceMs ?? 8_000;
  }

  private dir(name: string): string {
    return join(this.opts.queueDir, name);
  }

  /**
   * Is the bridge alive? Three possible answers:
   *   - fresh heartbeat                      -> yes
   *   - "busy" heartbeat, not absurdly old   -> yes, SketchUp is in the middle of a long tool
   *                                             (it cannot write a heartbeat while a tool runs)
   *   - stale / missing                      -> look again for a few seconds, then give up
   * Waiting a little before giving up matters: right after a long tool, the heartbeat
   * can be a moment old even though everything is fine (Windows test, 2026-10-29).
   */
  async ensureBridgeAlive(): Promise<void> {
    const file = join(this.opts.queueDir, "heartbeat.json");
    const deadline = Date.now() + this.heartbeatGraceMs;
    let lastProblem = "";
    for (;;) {
      if (!existsSync(file)) {
        lastProblem =
          `No heartbeat in ${this.opts.queueDir}. Is SketchUp open with the UMD Bridge extension loaded? ` +
          "(Extensions > UMD Bridge > Start)";
      } else {
        let beat: Heartbeat | null = null;
        try {
          beat = JSON.parse(readFileSync(file, "utf8")) as Heartbeat;
        } catch {
          // mid-rename on a slow disk: treat as unreadable and look again
        }
        const ageMs = beat ? Date.now() - Date.parse(beat.t ?? "") : Number.NaN;
        if (beat?.busy && ageMs <= this.opts.timeoutMs) return;
        if (ageMs <= this.heartbeatMaxAgeMs) return;
        lastProblem = Number.isFinite(ageMs)
          ? `The bridge heartbeat is ${Math.round(ageMs / 1000)} s old` +
            (beat?.busy ? ` (stuck on command ${beat.busy.id ?? "?"})` : "") +
            ". SketchUp is closed, frozen, or the bridge was stopped."
          : "The bridge heartbeat file can't be read.";
      }
      if (Date.now() >= deadline) throw new BridgeUnavailableError(lastProblem, "NO_HEARTBEAT");
      await sleep(Math.min(this.opts.pollMs, 250));
    }
  }

  async send(command: Command): Promise<Result> {
    await this.ensureBridgeAlive();

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
