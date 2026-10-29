import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BridgeClient } from "../../src/bridge/client";
import { FileQueueTransport } from "../../src/bridge/fileQueue";
import { BridgeUnavailableError } from "../../src/bridge/transport";
import { runSmoke } from "../../src/smoke/runSmoke";
import { FakeBridge } from "../helpers/fakeBridge";

// MOCK: a Node "fake bridge" stands in for SketchUp. This proves the FILE PROTOCOL
// (write, pick up, answer, timeouts) works; it does not prove the Ruby side works.

let dir: string;
let bridge: FakeBridge;

const transport = (timeoutMs = 2_000, heartbeatMaxAgeMs = 1_000) =>
  new FileQueueTransport({ queueDir: dir, timeoutMs, pollMs: 10, heartbeatMaxAgeMs, heartbeatGraceMs: 200 });

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "umd-queue-"));
  bridge = new FakeBridge(dir);
});

afterEach(() => {
  bridge.stop();
  rmSync(dir, { recursive: true, force: true });
});

describe("FileQueueTransport (mock bridge)", () => {
  it("round-trips a command through the folders", async () => {
    bridge.start();
    const client = new BridgeClient(transport());
    const res = await client.call("ping", {});
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.data.tools).toContain("createBox");
  });

  it("passes the whole smoke test through real files", async () => {
    bridge.start();
    const steps = await runSmoke(new BridgeClient(transport()), "test");
    const failed = steps.filter((s) => !s.pass && s.step !== "5 captureView"); // fake image path is not on disk
    expect(failed).toEqual([]);
  });

  it("fails fast with NO_HEARTBEAT when the bridge is not running", async () => {
    const t = transport();
    await expect(new BridgeClient(t).call("ping", {})).rejects.toMatchObject({ reason: "NO_HEARTBEAT" });
  });

  it("fails fast when the heartbeat is stale (SketchUp closed or frozen)", async () => {
    bridge.beat(new Date(Date.now() - 60_000));
    await expect(new BridgeClient(transport()).call("ping", {})).rejects.toMatchObject({ reason: "NO_HEARTBEAT" });
  });

  it("a tool that runs longer than the heartbeat limit does not break the NEXT command (Windows bug, 2026-10-29)", async () => {
    // Real run: saveCopy took 26 s, the heartbeat limit was 10 s, and the next command
    // failed with NO_HEARTBEAT even though SketchUp was fine. Here: 400 ms tool vs 150 ms limit.
    bridge.stop();
    bridge = new FakeBridge(dir, 400);
    bridge.start(20);
    const client = new BridgeClient(transport(3_000, 150));
    const first = await client.call("saveCopy", { fileName: "slow.skp" });
    expect(first.ok).toBe(true);
    const second = await client.call("saveCopy", { fileName: "slow.skp" }); // sent immediately after
    expect(!second.ok && second.error.code).toBe("FILE_EXISTS");
  });

  it("treats a 'busy' heartbeat as alive, even when it is older than the limit", async () => {
    bridge.beat(new Date(Date.now() - 5_000), { id: "20261029-000000-aaaaaa", since: new Date().toISOString() });
    await expect(transport(30_000).ensureBridgeAlive()).resolves.toBeUndefined();
  });

  it("gives up on a 'busy' heartbeat older than the command timeout (SketchUp crashed mid-tool)", async () => {
    bridge.beat(new Date(Date.now() - 60_000), { id: "20261029-000000-bbbbbb", since: new Date().toISOString() });
    await expect(transport(2_000).ensureBridgeAlive()).rejects.toMatchObject({ reason: "NO_HEARTBEAT" });
  });

  it("waits a moment for a stale heartbeat to recover instead of failing at once", async () => {
    bridge.beat(new Date(Date.now() - 60_000));
    setTimeout(() => bridge.start(), 80); // bridge comes back within the grace period
    const res = await new BridgeClient(transport()).call("ping", {});
    expect(res.ok).toBe(true);
  });

  it("cancels a command nobody picked up, so it can never run later", async () => {
    bridge.beat(); // heartbeat looks fresh, but the bridge loop is not running
    const err = await new BridgeClient(transport(150)).call("ping", {}).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BridgeUnavailableError);
    expect((err as BridgeUnavailableError).reason).toBe("NOT_PICKED_UP");
    const cancelled = join(dir, "cancelled");
    expect(existsSync(cancelled)).toBe(true);
  });

  it("says STILL_RUNNING (do not resend) when SketchUp took the command but has not finished", async () => {
    bridge.hang = true;
    bridge.start();
    await expect(new BridgeClient(transport(200)).call("ping", {})).rejects.toMatchObject({ reason: "STILL_RUNNING" });
  });

  it("rejects a corrupt result file instead of trusting it", async () => {
    bridge.hang = true;
    bridge.start();
    const t = transport(500);
    const client = new BridgeClient(t);
    const pending = client.call("ping", {});
    // write garbage where the answer should go, for whatever command is now in working/
    await new Promise((r) => setTimeout(r, 80));
    const { readdirSync } = await import("node:fs");
    const [file] = readdirSync(join(dir, "working"));
    writeFileSync(join(dir, "out", file!), "{ not json");
    await expect(pending).rejects.toMatchObject({ reason: "BAD_RESULT_FILE" });
  });
});
