import { describe, expect, it } from "vitest";
import { BridgeClient } from "../../src/bridge/client";
import { MockSketchUp } from "../../src/bridge/mockSketchUp";
import { groupNames, mismatchWarning, renderSummary, summarizeRoom } from "../../src/summary/roomSummary";

// MOCK: step 2b on the fake copy of the T128 reception room (src/bridge/mockScenes.ts).

const ROOM = "1F RECEPTION - TERRARIUMS + LOUNGE (T128, per revised plan)";

const setup = () => {
  const sketchup = new MockSketchUp({ scene: "reception" });
  return { sketchup, client: new BridgeClient(sketchup) };
};

describe("name vs contents", () => {
  it("flags a 'sofa' that only holds a palm (the real Sofa set 4)", () => {
    expect(mismatchWarning("Sofa set 4 - reception lounge", ["3DW Chamaedorea elegans - parlor palm"])).toMatch(/sofa.*plant/);
  });

  it("does not flag furniture made of unnamed parts", () => {
    expect(mismatchWarning("Sofa set 1 - curved boucle sofa", [])).toBeNull();
  });

  it("does not flag furniture that contains furniture", () => {
    expect(mismatchWarning("Lounge bay", ["curved sofa", "round table"])).toBeNull();
    expect(mismatchWarning("Sofa set 2", ["armchair", "palm"])).toBeNull();
  });

  it("does not flag things whose name makes no furniture claim", () => {
    expect(mismatchWarning("Terrarium A", ["palm", "fern"])).toBeNull();
  });

  it("counts repeated parts", () => {
    expect(groupNames(["post", "post", "glass", "", ""])).toEqual(["2× post", "glass", "2× (unnamed part)"]);
  });
});

describe("summarizeRoom", () => {
  it("lists every direct child with a ref, its box and its real contents", async () => {
    const { client } = setup();
    const s = await summarizeRoom(client, { path: [ROOM] });
    expect(s.items.map((i) => i.ref)).toEqual(["R1", "R2", "R3", "R4", "R5", "R6", "R7", "R8", "R9", "R10", "R11", "R12"]);
    const sofa4 = s.items.find((i) => i.name.startsWith("Sofa set 4"))!;
    expect(sofa4.contents).toEqual(["3DW Chamaedorea elegans - parlor palm (Botanist traveler)"]);
    expect(sofa4.categories).toEqual(["plant"]);
    expect(sofa4.warnings[0]).toMatch(/plant only/);
    const terrA = s.items.find((i) => i.name.startsWith("Terrarium A"))!;
    expect(terrA.contents).toContain("10× steel post 40");
    expect(terrA.bounds.max[0]).toBe(89.956); // real value from Windows
    expect(terrA.warnings).toEqual([]);
  });

  it("uses the confirmed 1F finish floor", async () => {
    const { client } = setup();
    const s = await summarizeRoom(client, { path: [ROOM] });
    expect(s.floor.z).toBe(1.489);
    expect(s.notes).toEqual([]);
  });

  it("refs point at persistent ids that resolve to the same object", async () => {
    const { client } = setup();
    const s = await summarizeRoom(client, { path: [ROOM] });
    const r3 = s.items[4]!; // R5 = Sofa set 4, as on the real model
    const back = await client.call("inspectEntity", { target: { persistentId: r3.persistentId } });
    expect(back.ok && back.data.name).toBe(r3.name);
  });

  it("marks items on a hidden tag as hidden", async () => {
    const { client } = setup();
    await client.call("setTagVisibility", { tag: "1F Reception - Lighting (T128)", visible: false });
    const s = await summarizeRoom(client, { path: [ROOM] });
    expect(s.items.find((i) => i.name.startsWith("CEILING LIGHTS"))!.visible).toBe(false);
    expect(renderSummary(s)).toMatch(/CEILING LIGHTS.*\[HIDDEN\]/);
  });

  it("only reads: sends no changing tool", async () => {
    const { sketchup, client } = setup();
    await summarizeRoom(client, { path: [ROOM] });
    expect(new Set(sketchup.received.map((c) => c.tool))).toEqual(new Set(["inspectEntity", "getModelInfo", "findEntities"]));
  });

  it("renders a compact text the model can read", async () => {
    const { client } = setup();
    const text = renderSummary(await summarizeRoom(client, { path: [ROOM] }));
    expect(text).toContain("floor level: z 1.489");
    expect(text).toContain("+x = east");
    expect(text).toMatch(/R5 {2}Sofa set 4[^\n]*\n.*\n.*contains: 3DW Chamaedorea[^\n]*\n {4}WARNING/);
    expect(text.length).toBeLessThan(8000); // ~2,000 tokens: fits a small model (real room: 5.6k)
  });

  it("lists only the UMD design materials and counts the rest", async () => {
    const { sketchup, client } = setup();
    for (const m of ["UMD Light Oak", "Material82", "BANANA_BIG_PLANT2"]) sketchup.materials.add(m);
    const s = await summarizeRoom(client, { path: [ROOM] });
    expect(s.materials).toEqual({ design: ["UMD Light Oak"], otherCount: 2 }); // Material82 is already in the scene
    expect(renderSummary(s)).toContain("DESIGN MATERIALS: UMD Light Oak   (+2 other materials");
  });

  it("counts every repeated part, even past 100 (real bug: 115 downlights printed as 100)", async () => {
    const { sketchup, client } = setup();
    const lights = sketchup.allEntities().find((e) => e.name.startsWith("CEILING LIGHTS"))!;
    // Like the real model: each downlight has parts of its own (4 here), which used to eat the search limit.
    for (const d of sketchup.allEntities().filter((x) => x.parentId === lights.entityId)) {
      for (let p = 0; p < 4; p++) sketchup.addEntity({ type: "Group", name: "lamp part", tag: "Layer0", parentId: d.entityId, bounds: d.bounds });
    }
    for (let i = 0; i < 112; i++) {
      const d = sketchup.addEntity({ type: "Group", name: "downlight", tag: "Layer0", parentId: lights.entityId, bounds: lights.bounds });
      for (let p = 0; p < 4; p++) sketchup.addEntity({ type: "Group", name: "lamp part", tag: "Layer0", parentId: d.entityId, bounds: d.bounds });
    }
    const s = await summarizeRoom(client, { path: [ROOM] });
    const item = s.items.find((i) => i.name.startsWith("CEILING LIGHTS"))!;
    expect(item.contents).toEqual(["115× downlight"]);
    expect(item.warnings).toEqual([]);
  });

  it("does not print (hidden) twice for tags already named so", async () => {
    const { client } = setup();
    await client.call("setTagVisibility", { tag: "Plants", visible: false });
    await client.call("moveToReplaced", { target: { path: [ROOM, "Sofa set 4 - reception lounge (copy of set 2, rotated 180, per revised plan)"] }, replacedBy: "T201" });
    const text = renderSummary(await summarizeRoom(client, { path: [ROOM] }));
    expect(text).toContain("zz_REPLACED by T201 (hidden)");
    expect(text).not.toContain("(hidden) (hidden)");
  });

  it("says which way long items run (Terrarium E runs north-south)", async () => {
    const { client } = setup();
    const text = renderSummary(await summarizeRoom(client, { path: [ROOM] }));
    expect(text).toMatch(/R8 {2}Terrarium E[^\n]*\n[^\n]*\| runs north-south/);
    expect(text).not.toMatch(/R5 {2}Sofa set 4[^\n]*\n[^\n]*\| runs/); // a 1 x 1 m item runs no particular way
  });

  it("throws a clear error for a room that does not exist", async () => {
    const { client } = setup();
    await expect(summarizeRoom(client, { path: ["No such room"] })).rejects.toThrow(/room not found/);
  });
});
