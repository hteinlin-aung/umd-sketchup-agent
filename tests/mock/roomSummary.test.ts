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
    expect(s.items.map((i) => i.ref)).toEqual(["R1", "R2", "R3", "R4", "R5", "R6"]);
    const sofa4 = s.items.find((i) => i.name.startsWith("Sofa set 4"))!;
    expect(sofa4.contents).toEqual(["3DW Chamaedorea elegans - parlor palm (Botanist traveler)"]);
    expect(sofa4.categories).toEqual(["plant"]);
    expect(sofa4.warnings[0]).toMatch(/plant only/);
    const terrA = s.items.find((i) => i.name.startsWith("Terrarium A"))!;
    expect(terrA.contents).toContain("3× steel post 40");
    expect(terrA.bounds.max[0]).toBe(25.6);
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
    const r3 = s.items[2]!;
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
    expect(text).toMatch(/R3 {2}Sofa set 4[^\n]*\n.*\n.*contains: 3DW Chamaedorea[^\n]*\n {4}WARNING/);
    expect(text.length).toBeLessThan(4000); // fits easily in a small model's context
  });

  it("throws a clear error for a room that does not exist", async () => {
    const { client } = setup();
    await expect(summarizeRoom(client, { path: ["No such room"] })).rejects.toThrow(/room not found/);
  });
});
