import { describe, expect, it } from "vitest";
import { loadCatalog } from "../../src/agent/catalog";
import { chooseComponents, componentName, similarComponents } from "../../src/agent/choose";
import type { Draft, DraftStep } from "../../src/agent/draft";
import { BridgeClient } from "../../src/bridge/client";
import { MockSketchUp } from "../../src/bridge/mockSketchUp";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// MOCK: "which one do you like?" with the fake components folder.

const setup = async () => {
  const sketchup = new MockSketchUp({ scene: "reception" });
  const client = new BridgeClient(sketchup);
  const { catalog } = await loadCatalog(client, { cachePath: join(mkdtempSync(join(tmpdir(), "umd-ch-")), "c.json") });
  return { sketchup, client, catalog };
};

const place = (id: string, line: number, component: string): DraftStep => ({
  op: "place", line, id, component, name: id, placement: { kind: "beside", anchor: "R8", side: "east", gap: 0.3, shift: 0 }, rotation: 0, base: 0, tag: "T",
});
const draftOf = (...steps: DraftStep[]): Draft => ({ steps: [...steps, { op: "save", line: 9, fileName: "x.skp" }], notDone: [] });

/** A fake designer who answers from a list, and records what was asked. */
const designer = (answers: string[]) => {
  const asked: string[] = [];
  return { asked, ask: async (q: string) => (asked.push(q), answers.shift() ?? "") };
};

describe("which one do you like?", () => {
  it("offers pieces of the same kind only (plants with plants, tables with tables)", async () => {
    const { catalog } = await setup();
    expect(similarComponents("3DW_Money tree potted.skp", catalog).map((c) => c.file)).toEqual(["3DW_Fittonia potted.skp"]);
    expect(similarComponents("3DW_Round marble coffee table.skp", catalog).map((c) => c.file)).toEqual(["3DW_coffee_table_marble_round.skp"]);
    expect(similarComponents("3DW_Mercy S curved boucle sofa.skp", catalog)).toEqual([]); // the only sofa
  });

  it("shows each option with its placed size and a preview, and uses the designer's pick", async () => {
    const { client, catalog } = await setup();
    const shown: string[] = [];
    const d = designer(["2"]);
    const out = await chooseComponents(client, draftOf(place("S1", 1, "3DW_Round marble coffee table.skp")), catalog, d.ask, (t) => shown.push(t));
    expect(shown[0]).toMatch(/\[1\] 3DW_Round marble coffee table\.skp {3}\(the agent's pick\)/);
    expect(shown[0]).toMatch(/\[2\] 3DW_coffee_table_marble_round\.skp\n {6}0\.63 x 0\.62 x 0\.42 m .*resized from a file drawn at the wrong scale/);
    expect(shown[0]).toMatch(/preview: MOCK\/images\/previews\/3DW_coffee_table_marble_round\.png/);
    expect((out.draft.steps[0] as { component: string }).component).toBe("3DW_coffee_table_marble_round.skp");
    expect(out.choices).toEqual([
      {
        step: "S1",
        line: 1,
        picked: "3DW_coffee_table_marble_round.skp",
        from: ["3DW_Round marble coffee table.skp", "3DW_coffee_table_marble_round.skp"],
        renamed: { from: "S1", to: "Coffee table marble round" },
      },
    ]);
  });

  it("renames a step to what was actually picked (no 'Money tree' that is a fittonia)", async () => {
    const { client, catalog } = await setup();
    const out = await chooseComponents(client, draftOf({ ...place("S1", 1, "3DW_Money tree potted.skp"), name: "Money tree" } as DraftStep), catalog, designer(["2"]).ask, () => {});
    expect(out.draft.steps[0]).toMatchObject({ component: "3DW_Fittonia potted.skp", name: "Fittonia potted" });
    expect(out.choices[0]!.renamed).toEqual({ from: "Money tree", to: "Fittonia potted" });
  });

  it.each([
    ["3DW_fittonia_SashaAlonso.skp", "Fittonia"],
    ["3DW_money_tree_Pachira_VitorB_86654.skp", "Money tree Pachira"],
    ["3DW_coffee_table_marble_round.skp", "Coffee table marble round"],
    ["3DW_banyan_tree_3D_MananC.skp", "Banyan tree"],
    ["ZEN+GARDEN3DW_zen_garden_Finkong.skp", "Zen garden Finkong"],
    ["3DW_SPACESCAN_tree_trunk_roots_9983.skp", "Tree trunk roots"],
  ])("names %s as %s", (file, name) => {
    expect(componentName(file)).toBe(name);
  });

  it("Enter keeps the agent's pick", async () => {
    const { client, catalog } = await setup();
    const out = await chooseComponents(client, draftOf(place("S1", 1, "3DW_Money tree potted.skp")), catalog, designer([""]).ask, () => {});
    expect((out.draft.steps[0] as { component: string }).component).toBe("3DW_Money tree potted.skp");
  });

  it("asks again after an answer that isn't one of the numbers", async () => {
    const { client, catalog } = await setup();
    const d = designer(["the plant", "7", "2"]);
    const shown: string[] = [];
    const out = await chooseComponents(client, draftOf(place("S1", 1, "3DW_Money tree potted.skp")), catalog, d.ask, (t) => shown.push(t));
    expect(d.asked).toHaveLength(3);
    expect(shown.filter((t) => /is not one of the numbers/.test(t))).toHaveLength(2);
    expect((out.draft.steps[0] as { component: string }).component).toBe("3DW_Fittonia potted.skp");
  });

  it("doesn't ask when there is nothing else to choose from", async () => {
    const { client, catalog } = await setup();
    const d = designer([]);
    await chooseComponents(client, draftOf(place("S1", 1, "3DW_Mercy S curved boucle sofa.skp")), catalog, d.ask, () => {});
    expect(d.asked).toEqual([]);
  });

  it("plan only (--dry): lists the options but keeps the agent's picks", async () => {
    const { client, catalog } = await setup();
    const shown: string[] = [];
    const out = await chooseComponents(client, draftOf(place("S1", 1, "3DW_Money tree potted.skp")), catalog, null, (t) => shown.push(t));
    expect(shown).toHaveLength(1);
    expect(out.choices[0]!.picked).toBe("3DW_Money tree potted.skp");
  });

  it("never touches the model: previews are made from the files", async () => {
    const { sketchup, client, catalog } = await setup();
    const before = sketchup.allEntities().length;
    await chooseComponents(client, draftOf(place("S1", 1, "3DW_Money tree potted.skp")), catalog, designer(["2"]).ask, () => {});
    expect(sketchup.allEntities().length).toBe(before);
  });
});
