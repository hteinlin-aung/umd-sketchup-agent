import { describe, expect, it } from "vitest";
import { BridgeClient } from "../../src/bridge/client";
import { MockSketchUp } from "../../src/bridge/mockSketchUp";
import { finishFloor } from "../../src/project/umdLevels";
import { runWeek2 } from "../../src/smoke/runWeek2";

// MOCK: TypeScript side of the Week 2 changing tools. Real proof: `npm run smoke:w2` on Windows.

const setup = (opts?: ConstructorParameters<typeof MockSketchUp>[0]) => {
  const sketchup = new MockSketchUp(opts);
  return { sketchup, client: new BridgeClient(sketchup) };
};
const bench = { jobGroup: "AGENT T201", name: "oak bench", tag: "AGENT", z0: 1.489, z1: 1.939 };

describe("Week 2 checks against the mock", () => {
  it("pass every step", async () => {
    const steps = await runWeek2(setup().client, "test");
    expect(steps.filter((s) => !s.pass)).toEqual([]);
    expect(steps).toHaveLength(9);
  });
});

describe("createPrism", () => {
  it("reports area and volume of the footprint it built", async () => {
    const res = await setup().client.call("createPrism", { ...bench, points: [[0, 0], [2, 0], [2, 0.5], [0, 0.5]] });
    expect(res.ok && res.data.footprintAreaM2).toBe(1);
    expect(res.ok && res.data.volumeM3).toBe(0.45);
    expect(res.ok && res.data.faceCount).toBe(6);
  });

  it("refuses a footprint with a repeated point or no area, before sending", async () => {
    const { sketchup, client } = setup();
    const repeated = await client.call("createPrism", { ...bench, points: [[0, 0], [1, 0], [1, 0], [0, 1]] });
    const flat = await client.call("createPrism", { ...bench, points: [[0, 0], [1, 0], [2, 0]] });
    expect(!repeated.ok && repeated.source).toBe("client");
    expect(!flat.ok && flat.source).toBe("client");
    expect(sketchup.received).toHaveLength(0);
  });

  it("is refused on the MASTER", async () => {
    const { client } = setup({ modelPath: "E:/x/Urban_Mind_Detox_MASTER.skp", targetPattern: "Urban" });
    const res = await client.call("createPrism", { ...bench, points: [[0, 0], [1, 0], [1, 1]] });
    expect(!res.ok && res.error.code).toBe("MASTER_PROTECTED");
  });
});

describe("tags", () => {
  it("setTag reports the old tag and creates the new one", async () => {
    const { sketchup, client } = setup();
    const res = await client.call("setTag", { target: { path: ["UMD 1F", "1F RECEPTION (T128)"] }, tag: "New tag" });
    expect(res.ok && [res.data.previousTag, res.data.created]).toEqual(["1F Shell", true]);
    expect(sketchup.tags.get("New tag")).toBe(true);
  });

  it("setTagVisibility refuses unknown tags and Untagged", async () => {
    const { client } = setup();
    const unknown = await client.call("setTagVisibility", { tag: "Nope", visible: false });
    const untagged = await client.call("setTagVisibility", { tag: "Layer0", visible: false });
    expect(!unknown.ok && unknown.error.code).toBe("NOT_FOUND");
    expect(!untagged.ok && untagged.error.code).toBe("INVALID_ARGS");
  });

  it("moveToReplaced hides the object on a zz_REPLACED tag and keeps it", async () => {
    const { sketchup, client } = setup();
    const benchEntity = sketchup.allEntities().find((e) => e.name === "Reception bench - light oak")!;
    const res = await client.call("moveToReplaced", { target: { entityId: benchEntity.entityId }, replacedBy: "T201 oak bench" });
    expect(res.ok && res.data.tag).toBe("zz_REPLACED by T201 oak bench (hidden)");
    expect(sketchup.entity(benchEntity.entityId)).toBeDefined();
    expect(sketchup.tags.get("zz_REPLACED by T201 oak bench (hidden)")).toBe(false);
  });
});

describe("confirmed levels", () => {
  it("uses the levels measured on the MASTER on 2026-11-02", () => {
    expect([finishFloor("1F"), finishFloor("2F"), finishFloor("3F")]).toEqual([1.489, 5.479, 10.979]);
  });
});
