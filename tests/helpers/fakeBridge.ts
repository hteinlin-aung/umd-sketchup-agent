import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { MockSketchUp } from "../../src/bridge/mockSketchUp";
import type { Command } from "../../src/protocol/envelope";

/**
 * Plays the part of the Ruby bridge for file-queue tests: watches in/, moves the
 * command to working/, answers with MockSketchUp, writes out/ atomically, and
 * keeps heartbeat.json fresh. Lets us test FileQueueTransport on any machine.
 */
export class FakeBridge {
  readonly sketchup = new MockSketchUp();
  private timer: NodeJS.Timeout | null = null;
  private busy = false;
  /** When true, commands are moved to working/ but never answered (simulates a long job). */
  hang = false;

  constructor(private readonly dir: string) {
    for (const d of ["in", "working", "out", "done"]) mkdirSync(join(dir, d), { recursive: true });
  }

  beat(at = new Date()): void {
    const f = join(this.dir, "heartbeat.json");
    writeFileSync(`${f}.tmp`, JSON.stringify({ t: at.toISOString(), bridgeVersion: "fake" }));
    renameSync(`${f}.tmp`, f);
  }

  start(intervalMs = 20): void {
    this.beat();
    this.timer = setInterval(() => void this.tick(), intervalMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private async tick(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      this.beat();
      const files = readdirSync(join(this.dir, "in")).filter((f) => f.endsWith(".json")).sort();
      for (const f of files) {
        const working = join(this.dir, "working", f);
        try {
          renameSync(join(this.dir, "in", f), working);
        } catch {
          continue;
        }
        if (this.hang) continue;
        const command = JSON.parse(readFileSync(working, "utf8")) as Command;
        const result = await this.sketchup.send(command);
        const out = join(this.dir, "out", f);
        if (!existsSync(out)) {
          writeFileSync(`${out}.tmp`, JSON.stringify(result));
          renameSync(`${out}.tmp`, out);
        }
        renameSync(working, join(this.dir, "done", f));
      }
    } finally {
      this.busy = false;
    }
  }
}
