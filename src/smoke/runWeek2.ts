import type { BridgeClient } from "../bridge/client";
import { BridgeUnavailableError } from "../bridge/transport";
import { finishFloor } from "../project/umdLevels";
import { polygonArea, replacedTagName, type Vec2 } from "../protocol/tools";
import type { StepResult } from "./runSmoke";

/**
 * Week 2 step 2a acceptance checks for the CHANGING tools (createPrism, setTag,
 * setTagVisibility, moveToReplaced). Same idea as the Week 1 smoke test: every
 * step checks a MEASURED value. Works on the mock and on real SketchUp.
 * Everything is built 5 m outside the model, on its own "AGENT TEST" tags.
 */
export async function runWeek2(client: BridgeClient, runId: string): Promise<StepResult[]> {
  const steps: StepResult[] = [];
  const record = (step: string, pass: boolean, detail: string) => {
    steps.push({ step, pass, detail });
    return pass;
  };
  try {
    await checks(client, runId, record);
  } catch (e) {
    if (!(e instanceof BridgeUnavailableError)) throw e;
    record("bridge", false, `stopped after ${steps.length} step(s): ${e.reason}: ${e.message}`);
  }
  return steps;
}

type Record = (step: string, pass: boolean, detail: string) => boolean;

async function checks(client: BridgeClient, runId: string, record: Record): Promise<void> {
  const ping = await client.call("ping", {});
  const needed = ["createPrism", "setTag", "setTagVisibility", "moveToReplaced"];
  const missing = ping.ok ? needed.filter((t) => !ping.data.tools.includes(t)) : needed;
  if (!record("1 new tools", ping.ok && missing.length === 0, ping.ok ? `bridge ${ping.data.bridgeVersion}${missing.length ? `, MISSING ${missing.join(", ")}` : ""}` : ping.error.code)) {
    return;
  }

  const info = await client.call("getModelInfo", { maxItems: 10 });
  if (!info.ok || !info.data.modelBounds) {
    record("2 getModelInfo", false, info.ok ? "model is empty" : info.error.code);
    return;
  }
  // An L-shaped built-in bench, 450 mm high, standing on the 1F finish floor, 5 m past the model's +X edge.
  const x = Math.round((info.data.modelBounds.max[0] + 5) * 1000) / 1000;
  const y = Math.round(info.data.modelBounds.min[1] * 1000) / 1000;
  const z0 = finishFloor("1F");
  const lShape: Vec2[] = [
    [x, y],
    [x + 3, y],
    [x + 3, y + 0.5],
    [x + 0.5, y + 0.5],
    [x + 0.5, y + 2],
    [x, y + 2],
  ];
  const job = `AGENT TEST - week2 ${runId}`;
  const tag = "AGENT TEST";

  const prism = await client.call("createPrism", { jobGroup: job, name: "L bench 450", tag, points: lShape, z0, z1: z0 + 0.45 });
  if (!prism.ok) {
    record("3 createPrism", false, `${prism.error.code}: ${prism.error.message}`);
    return;
  }
  const expectedVolume = polygonArea(lShape) * 0.45;
  const volErr = Math.abs(prism.data.volumeM3 - expectedVolume);
  record(
    "3 createPrism",
    volErr <= expectedVolume * 0.001 && Math.abs(prism.data.worldBounds.min[2] - z0) <= 0.001,
    `L-shape area ${prism.data.footprintAreaM2} m², volume ${prism.data.volumeM3} m³ (expected ${expectedVolume.toFixed(6)}), ` +
      `${prism.data.faceCount} faces, bottom at z ${prism.data.worldBounds.min[2]}`,
  );

  // A footprint whose edges cross ("bow tie") must never be reported as a good solid.
  const bowTie: Vec2[] = [
    [x + 4, y],
    [x + 6, y + 1.5],
    [x + 6, y],
    [x + 4, y + 2],
  ];
  const bad = await client.call("createPrism", { jobGroup: job, name: "bow tie", tag, points: bowTie, z0, z1: z0 + 0.45 });
  record("4 crossing edges", !bad.ok, bad.ok ? "ACCEPTED a self-crossing footprint" : `${bad.error.code} (${bad.source})`);

  const target = { entityId: prism.data.entityId };
  const top: [number, number, number] = [x + 0.25, y + 1, z0 + 2]; // a point above the bench's short leg
  const before = await client.call("measure", { from: top, direction: "down" });
  const hitBench = before.ok && before.data.hits[0]?.path.at(-1) === "L bench 450";
  record("5 measure sees it", hitBench, before.ok ? `first hit: ${before.data.hits[0]?.path.join(" > ") ?? "nothing"}` : before.error.code);

  const retag = await client.call("setTag", { target, tag: "AGENT TEST - tags" });
  record("6 setTag", retag.ok && retag.data.previousTag === tag && retag.data.tag === "AGENT TEST - tags", retag.ok ? `${retag.data.previousTag} → ${retag.data.tag}` : retag.error.code);

  const hide = await client.call("setTagVisibility", { tag: "AGENT TEST - tags", visible: false });
  const after = await client.call("measure", { from: top, direction: "down" });
  const hidden = after.ok && after.data.hits[0]?.path.at(-1) !== "L bench 450";
  record("7 hide tag", hide.ok && !hide.data.visible && hidden, hidden ? "measure no longer sees the bench" : "bench still visible to measure");

  const show = await client.call("setTagVisibility", { tag: "AGENT TEST - tags", visible: true });
  record("8 show tag", show.ok && show.data.previous === false && show.data.visible, show.ok ? "visible again" : show.error.code);

  const replaced = await client.call("moveToReplaced", { target, replacedBy: `week2 test ${runId}` });
  const still = await client.call("inspectEntity", { target });
  record(
    "9 moveToReplaced",
    replaced.ok && still.ok && still.data.tag === replacedTagName(`week2 test ${runId}`),
    still.ok ? `still exists, now on "${still.data.tag}"` : `${still.error.code}: object is gone!`,
  );

  const layer0 = await client.call("setTagVisibility", { tag: "Layer0", visible: false });
  record("10 untagged stays", !layer0.ok, layer0.ok ? "HID Untagged" : layer0.error.code);
}
