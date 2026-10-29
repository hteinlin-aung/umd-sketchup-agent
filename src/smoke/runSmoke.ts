import { existsSync, statSync } from "node:fs";
import type { BridgeClient } from "../bridge/client";
import { BridgeUnavailableError } from "../bridge/transport";
import type { Bounds, Vec3 } from "../protocol/tools";

/**
 * The Week 1 acceptance test (PLAN.md §7). The same code runs against the
 * mock (Mac) and against real SketchUp (Windows), so the steps are identical.
 * Every step checks a MEASURED value, never just "the call returned".
 */

// A smoke test is a basic test that checks whether the major parts of a system work together.
//The purpose is to detect major problems quickly.

export type StepResult = { step: string; pass: boolean; detail: string };

const TOLERANCE_M = 0.001; // 1 mm

/**
 * Runs every step and ALWAYS returns the steps done so far. If SketchUp stops
 * answering half-way, that becomes one FAIL line instead of an exception that
 * hides the earlier PASS lines (Windows test, 2026-10-29).
 */
export async function runSmoke(client: BridgeClient, runId = smokeRunId()): Promise<StepResult[]> {
  const steps: StepResult[] = [];
  const record = (step: string, pass: boolean, detail: string) => {
    steps.push({ step, pass, detail });
    return pass;
  };
  try {
    await runSteps(client, runId, record);
  } catch (e) {
    if (!(e instanceof BridgeUnavailableError)) throw e;
    record("bridge", false, `stopped after ${steps.length} step(s): ${e.reason}: ${e.message}`);
  }
  return steps;
}

type Record = (step: string, pass: boolean, detail: string) => boolean;

async function runSteps(client: BridgeClient, runId: string, record: Record): Promise<void> {
  const isMock = client.transportKind === "mock";

  // 1. ping
  const ping = await client.call("ping", {});
  if (!ping.ok) {
    record("1 ping", false, `${ping.error.code}: ${ping.error.message}`);
    return; // nothing else can work
  }
  const expectedTools = ["ping", "getModelInfo", "createBox", "applyMaterial", "captureView", "saveCopy"];
  const missing = expectedTools.filter((t) => !ping.data.tools.includes(t));
  const versionOk = /^(25\.|MOCK$)/.test(ping.data.sketchupVersion); // SketchUp 2025 = 25.x
  record(
    "1 ping",
    versionOk && missing.length === 0,
    `SketchUp ${ping.data.sketchupVersion}, bridge ${ping.data.bridgeVersion}, model ${ping.data.modelTitle}` +
      (missing.length ? `, MISSING tools: ${missing.join(", ")}` : ""),
  );

  // 2. getModelInfo
  const info = await client.call("getModelInfo", { maxItems: 50 });
  if (!info.ok) {
    record("2 getModelInfo", false, `${info.error.code}: ${info.error.message}`);
    return;
  }
  const names = info.data.topLevel.map((e) => `${e.name || e.definitionName} [${size(e.bounds)}]`);
  record(
    "2 getModelInfo",
    info.data.topLevel.length > 0,
    `${info.data.topLevel.length} top-level groups: ${names.slice(0, 6).join("; ")}${names.length > 6 ? " ..." : ""}`,
  );

  // 3. createBox: 4 x 3 x 3.2 m, placed 5 m past the model's +X edge so it never touches the design.
  // Its height (z) is the model's lowest point, NOT a floor level; floor levels get measured separately.
  const mb = info.data.modelBounds;
  const x0 = round((mb ? mb.max[0] : 0) + 5);
  const y0 = round(mb ? mb.min[1] : 0);
  const z0 = round(mb ? mb.min[2] : 0);
  const want: Bounds = { min: [x0, y0, z0], max: [x0 + 4, y0 + 3, z0 + 3.2] };
  const box = await client.call("createBox", {
    jobGroup: `AGENT TEST - smoke ${runId}`,
    name: "smoke box 4x3x3.2",
    tag: "AGENT TEST",
    min: want.min,
    max: want.max,
  });
  if (!box.ok) {
    record("3 createBox", false, `${box.error.code}: ${box.error.message}`);
    return;
  }
  const err = maxDiff(box.data.worldBounds, want);
  record(
    "3 createBox",
    err <= TOLERANCE_M && box.data.faceCount === 6,
    `measured ${size(box.data.worldBounds)}, max error ${(err * 1000).toFixed(3)} mm, ${box.data.faceCount} faces, ` +
      `at z ${z0} m (model's lowest point)`,
  );

  // 4. applyMaterial: creates the test material if needed, then reads every face back
  const paint = await client.call("applyMaterial", {
    target: { entityId: box.data.entityId },
    material: "UMD Agent Test Orange",
    color: [230, 120, 40],
  });
  record(
    "4 applyMaterial",
    paint.ok && paint.data.facesPainted === 6 && paint.data.facesChecked === 6,
    paint.ok
      ? `${paint.data.facesPainted} painted, ${paint.data.facesChecked} confirmed${paint.data.created ? " (material created)" : ""}`
      : `${paint.error.code}: ${paint.error.message}`,
  );

  // 5. captureView
  const shot = await client.call("captureView", {
    fileName: `smoke_${runId}.png`,
    width: 1280,
    height: 720,
    zoomTo: { entityId: box.data.entityId },
  });
  if (shot.ok) {
    const onDisk = isMock || (existsSync(shot.data.path) && statSync(shot.data.path).size > 0);
    record("5 captureView", shot.data.bytes > 0 && onDisk, `${shot.data.path} (${shot.data.bytes} bytes${onDisk ? "" : ", NOT FOUND on disk"})`);
  } else {
    record("5 captureView", false, `${shot.error.code}: ${shot.error.message}`);
  }

  // 6. saveCopy, then saving the same name again must be refused
  const copyName = `smoke_${runId}.skp`;
  const copy = await client.call("saveCopy", { fileName: copyName });
  record("6 saveCopy", copy.ok && copy.data.bytes > 0, copy.ok ? `${copy.data.path} (${copy.data.bytes} bytes)` : `${copy.error.code}: ${copy.error.message}`);
  const again = await client.call("saveCopy", { fileName: copyName });
  record("6b no overwrite", !again.ok && again.error.code === "FILE_EXISTS", again.ok ? "overwrote the file!" : again.error.code);

  // 7. SketchUp itself must reject bad input, even if a buggy sender skipped the Zod check
  const unknown = await client.sendRaw("deleteEverything", {});
  record("7a unknown tool", !unknown.ok && unknown.error?.code === "UNKNOWN_TOOL", unknown.error?.code ?? "accepted!");
  const bad = await client.sendRaw("createBox", { jobGroup: "x", name: "x", tag: "x", min: [0, 0, 0], max: [-1, 1, 1] });
  record("7b bad args", !bad.ok && bad.error?.code === "INVALID_ARGS", bad.error?.code ?? "accepted!");
  const extra = await client.sendRaw("ping", { ruby: "Sketchup.active_model.entities.clear!" });
  record("7c unknown arg", !extra.ok && extra.error?.code === "INVALID_ARGS", extra.error?.code ?? "accepted!");

}

export function smokeRunId(now = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}_${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`;
}

function round(v: number): number {
  return Math.round(v * 1000) / 1000;
}

function size(b: Bounds): string {
  const d = (i: number) => (b.max[i]! - b.min[i]!).toFixed(3);
  return `${d(0)} x ${d(1)} x ${d(2)} m`;
}

function maxDiff(a: Bounds, b: Bounds): number {
  const diffs = (p: Vec3, q: Vec3) => p.map((v, i) => Math.abs(v - q[i]!));
  return Math.max(...diffs(a.min, b.min), ...diffs(a.max, b.max));
}
