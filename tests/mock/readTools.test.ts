import { describe, expect, it } from "vitest";
import { BridgeClient } from "../../src/bridge/client";
import { MockSketchUp } from "../../src/bridge/mockSketchUp";
import { defaultProbes, readLevels, summarizeFloors } from "../../src/levels/readLevels";

// MOCK: the TypeScript side of the Week 2 read tools. The Ruby logic is covered by
// tests/ruby/read_tools_test.rb; real geometry by running them on Windows.

const setup = (opts?: ConstructorParameters<typeof MockSketchUp>[0]) => {
  const sketchup = new MockSketchUp(opts);
  return { sketchup, client: new BridgeClient(sketchup) };
};

describe("findEntities", () => {
  it("finds nested things by part of their name, with their path", async () => {
    const { client } = setup();
    const res = await client.call("findEntities", { name: "bench" });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.matches).toHaveLength(1);
    expect(res.data.matches[0]!.path).toEqual(["UMD 1F", "1F RECEPTION (T128)", "Reception bench - light oak"]);
  });

  it("searches only inside the group you name", async () => {
    const { client } = setup();
    const res = await client.call("findEntities", { within: { path: ["UMD 1F", "1F RECEPTION (T128)"] } });
    expect(res.ok && res.data.matches.map((m) => m.name)).toEqual(["Reception bench - light oak", "Reception ceiling"]);
  });

  it("filters by tag (any case) and reports truncation", async () => {
    const { client } = setup();
    const tagged = await client.call("findEntities", { tag: "columns" });
    expect(tagged.ok && tagged.data.matches).toHaveLength(2);
    const limited = await client.call("findEntities", { limit: 1 });
    expect(limited.ok && limited.data.truncated).toBe(true);
  });

  it("is allowed on the MASTER (read-only)", async () => {
    const { client } = setup({ modelPath: "E:/x/Urban_Mind_Detox_MASTER_v01.skp", targetPattern: null });
    expect((await client.call("findEntities", { name: "bench" })).ok).toBe(true);
    expect((await client.call("measure", { from: [12, 6.2, 30] })).ok).toBe(true);
  });
});

describe("inspectEntity", () => {
  it("reports size, faces, materials and children", async () => {
    const { client } = setup();
    const res = await client.call("inspectEntity", { target: { path: ["UMD 1F", "1F RECEPTION (T128)"] } });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.size).toEqual([10, 10, 3.211]);
    expect(res.data.childCount).toBe(2);
    expect(res.data.children.map((c) => c.name)).toContain("Reception bench - light oak");
    expect(res.data.materials).toEqual([{ name: "(default)", faces: 6 }]);
  });
});

describe("measure", () => {
  it("lists every surface straight down, nearest first", async () => {
    const { client } = setup();
    const res = await client.call("measure", { from: [12, 6.2, 30], allHits: true });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    // ceiling (3.5 / 3.4), bench top (0.739), bench bottom + floor plate top (0.289), slab bottom (0.089)
    expect(res.data.hits.map((h) => h.point[2])).toEqual([3.5, 3.4, 0.739, 0.289, 0.289, 0.089]);
    expect(res.data.hits[0]!.path).toEqual(["UMD 1F", "1F RECEPTION (T128)", "Reception ceiling"]);
    expect(res.data.stoppedBecause).toBe("noMoreHits");
  });

  it("gives only the first surface unless allHits is set", async () => {
    const { client } = setup();
    const res = await client.call("measure", { from: [12, 6.2, 30] });
    expect(res.ok && res.data.hits).toHaveLength(1);
    expect(res.ok && res.data.stoppedBecause).toBe("maxHits");
  });

  it("stops at maxDistance", async () => {
    const { client } = setup();
    const res = await client.call("measure", { from: [12, 6.2, 30], allHits: true, maxDistance: 27 });
    expect(res.ok && res.data.hits.map((h) => h.point[2])).toEqual([3.5, 3.4]);
    expect(res.ok && res.data.stoppedBecause).toBe("maxDistance");
  });

  it("measures sideways too (east = +x)", async () => {
    const { client } = setup();
    const res = await client.call("measure", { from: [0, 6.2, 0.5], direction: "east", allHits: true });
    expect(res.ok && res.data.hits[0]!.point[0]).toBe(11); // the bench's west face
  });
});

describe("readLevels", () => {
  it("probes each floor group and marks floor-like surfaces", async () => {
    const { client } = setup();
    const results = await readLevels(client, [{ label: "reception", x: 12, y: 6.2 }]);
    const floorHits = results[0]!.hits.filter((h) => h.looksLikeFloor).map((h) => h.z);
    expect(floorHits).toEqual([0.289, 0.089]); // the floor plate's top and bottom
  });

  it("defaults to a 3 x 3 grid inside each 'UMD nF' group (the centre alone can miss the building)", () => {
    const probes = defaultProbes({
      modelPath: "",
      modelBounds: null,
      counts: { definitions: 0, materials: 0, tags: 0, scenes: 0 },
      tags: [],
      scenes: [],
      materials: [],
      truncated: false,
      topLevel: [
        { entityId: 1, persistentId: 1, type: "Group", name: "UMD 1F", definitionName: "", tag: "", hidden: false, childCount: 0, bounds: { min: [0, 0, 0], max: [10, 20, 5] } },
        { entityId: 2, persistentId: 2, type: "Group", name: "GARDEN", definitionName: "", tag: "", hidden: false, childCount: 0, bounds: { min: [0, 0, 0], max: [1, 1, 1] } },
      ],
    });
    expect(probes).toHaveLength(9);
    expect(probes).toContainEqual({ label: "UMD 1F @50%,50%", x: 5, y: 10 });
    expect(probes).toContainEqual({ label: "UMD 1F @25%,25%", x: 2.5, y: 5 });
  });
});

describe("summarizeFloors", () => {
  it("lists each floor-like height once, with how many probes saw it", async () => {
    const { client } = setup();
    const results = await readLevels(client, [
      { label: "a", x: 12, y: 6.2 },
      { label: "b", x: 0, y: 0 },
      { label: "lake", x: 500, y: 500 }, // misses everything, like the 1F centre on the real model
    ]);
    expect(summarizeFloors(results)).toEqual([
      { z: 0.289, probes: 2, example: "UMD 1F > 1F floor plate (finish surface)" },
      { z: 0.089, probes: 2, example: "UMD 1F > 1F floor plate (finish surface)" },
    ]);
  });
});
