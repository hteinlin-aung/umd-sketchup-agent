import { describe, expect, it } from "vitest";
import { Draft, type DraftStep } from "../../src/agent/draft";
import { checkAnswer, namesToRefs } from "../../src/agent/planner";
import { resolveDraft } from "../../src/agent/resolve";
import { sameCollisions } from "../../src/geometry/checks";
import { mentions, renderSummary } from "../../src/summary/roomSummary";
import { findSubRooms, roomLabels, type TradeItem } from "../../src/summary/subRooms";
import { t124, t124Trade } from "../helpers/t124";

// T124 sub-rooms and the "inside" placement (Mac decision 2026-11-14), on a cut-down copy of the real 3F group.

const OPTS = { runId: "test", briefName: "3F_therapy1_inside" };
const SAVE: DraftStep = { op: "save", line: 9, fileName: "out.skp" };
const plan = (steps: DraftStep[]) => resolveDraft(Draft.parse({ steps: [...steps, SAVE], notDone: [] }), t124(), OPTS);
const bench = (placement: object): DraftStep =>
  ({ op: "build", line: 1, id: "S1", name: "Bench", placement, height: 0.45, base: 0, tag: "T" }) as DraftStep;

describe("sub-rooms from names", () => {
  it("finds the rooms of a group organised by trade, in natural order, with V refs", () => {
    const rooms = t124().subRooms!;
    expect(rooms.map((r) => `${r.ref} ${r.name}`)).toEqual(["V1 Group therapy", "V2 Therapy 1", "V3 Therapy 2"]);
  });

  it("takes a room's box from its floor finish, from the floor level to the top of the group", () => {
    const t1 = t124().subRooms!.find((r) => r.name === "Therapy 1")!;
    expect(t1.bounds).toEqual({ min: [8.72, 76.06, 10.979], max: [18.8, 80.46, 13.9] });
    expect(t1.boxFrom).toMatch(/floor finish "Therapy 1 - M09 acoustic carpet greige"/);
    expect(t1.boxRefs).toEqual(["R2"]);
  });

  it("lists its parts once each, joining copies and the pieces of one named wall; ceilings and the floor finish are left out", () => {
    const t1 = t124().subRooms!.find((r) => r.name === "Therapy 1")!;
    expect(t1.parts.map((p) => `${p.ref} ${p.count}x ${p.name}`)).toEqual([
      "R14 2x Therapy 1 south wall",
      "R15 1x Therapy 1 door 900",
      "R16 2x Therapy 1 - armchair (3DW Moroso Gogan, boucle) on CAD U armchair",
      "R17 1x Therapy 1 - desk (oak top, walnut legs) on CAD desk",
      "R18 4x Therapy 1 feature wall (north)",
    ]);
    expect(t1.parts.find((p) => p.ref === "R18")!.from).toEqual(["R4", "R5"]);
  });

  it("leaves a normal room alone: labels found in one item only are not rooms (the 1F reception's sofa sets)", () => {
    const items: TradeItem[] = [
      { ref: "R1", name: "Lounge bay", parts: t124Trade()[0]!.parts.map((p, i) => ({ ...p, name: `Sofa set ${i + 1} - curved sofa` })) },
      { ref: "R2", name: "Terrarium A", parts: [{ ...t124Trade()[0]!.parts[0]!, name: "glass W" }] },
    ];
    expect(roomLabels(items)).toEqual([]);
    expect(findSubRooms(items, { floorZ: 0, top: 3 }, 3)).toEqual([]);
  });

  it("does not read 'Therapy 10' as 'Therapy 1'", () => {
    expect(mentions("put it in Therapy 10", "Therapy 1")).toBe(false);
    expect(mentions("In Therapy 1, a bench", "Therapy 1")).toBe(true);
    expect(mentions("in therapy 1.", "Therapy 1")).toBe(true);
  });
});

describe("the summary the model reads", () => {
  it("lists the parts of the rooms the brief names, and one line for the others", () => {
    const text = renderSummary(t124(), { focus: "1. In Therapy 1, a light oak bench against its south wall" });
    expect(text).toMatch(/SUB-ROOMS/);
    expect(text).toMatch(/V2 {2}Therapy 1 {2}\[SUB-ROOM\]/);
    expect(text).toMatch(/R15 {2}door 900 \|/);
    expect(text).toMatch(/V3 {2}Therapy 2 {2}\[SUB-ROOM\][\s\S]*2 parts, not listed here/);
    expect(text).not.toMatch(/R19 /);
  });

  it("lists every room's parts when the brief names none", () => {
    const text = renderSummary(t124());
    expect(text).toMatch(/R19 /);
    expect(text).not.toMatch(/not listed here/);
  });
});

describe('placement "inside"', () => {
  it("puts a block against the south side of a sub-room, the gap measured inward (brief 9's bench)", () => {
    const p = plan([bench({ kind: "inside", anchor: "V2", side: "south", gap: 0.1, eastWest: 2.4, northSouth: 0.4, shift: -2.485 })]);
    expect(p.errors).toEqual([]);
    expect(p.actions[0]!.box).toEqual({ min: [10.075, 76.16, 10.979], max: [12.475, 76.56, 11.429] });
    expect(p.actions[0]!.details[0]).toMatch(/inside V2 "Therapy 1", 0.1 m from its south side, centred along it, shifted 2.485 m west/);
  });

  it("works on the east side too (brief 9's shelf)", () => {
    const p = plan([bench({ kind: "inside", anchor: "V2", side: "east", gap: 0.05, eastWest: 0.3, northSouth: 2.0, shift: 1.04 })]);
    expect(p.actions[0]!.box).toEqual({ min: [18.45, 78.3, 10.979], max: [18.75, 80.3, 11.429] });
  });

  it('"room" is the whole room group', () => {
    const p = plan([bench({ kind: "inside", anchor: "room", side: "north", gap: 0, eastWest: 1, northSouth: 0.5, shift: 0 })]);
    expect(p.actions[0]!.box!.max[1]).toBe(89.481);
  });

  it("refuses a block that pokes out of the room, and says by how much", () => {
    const p = plan([bench({ kind: "inside", anchor: "V2", side: "south", gap: 0.1, eastWest: 2.4, northSouth: 5, shift: 0 })]);
    expect(p.errors.join()).toMatch(/S1 does not fit inside V2 "Therapy 1" \(10.08 m east-west x 4.4 m north-south inside\): it reaches 0.7 m past its north side/);
  });

  it("no longer warns about the trade items every block overlaps, only about real parts", () => {
    const clear = plan([bench({ kind: "inside", anchor: "V2", side: "south", gap: 0.1, eastWest: 2.4, northSouth: 0.4, shift: -2.485 })]);
    expect(clear.actions[0]!.warnings.filter((w) => /overlaps R[124568]\b/.test(w))).toEqual([]);
    const onDesk = plan([bench({ kind: "inside", anchor: "V2", side: "east", gap: 1.9, eastWest: 0.5, northSouth: 0.5, shift: 1 })]);
    expect(onDesk.actions[0]!.warnings.join()).toMatch(/overlaps R17 "Therapy 1 - desk/);
  });

  it("can stand beside a part of a sub-room (R16, the armchairs)", () => {
    const p = plan([bench({ kind: "beside", anchor: "R16", side: "south", gap: 0.3, eastWest: 1, northSouth: 0.4, shift: 0 })]);
    expect(p.errors).toEqual([]);
  });

  it("never takes out a sub-room or a part of one", () => {
    for (const target of ["V2", "R16"]) {
      const p = plan([{ op: "replace", line: 1, target } as DraftStep]);
      expect(p.errors.join()).toMatch(/can be measured from, but not taken out/);
      expect(p.actions.filter((a) => a.tool === "moveToReplaced")).toEqual([]);
    }
  });
});

describe("the planner and sub-rooms", () => {
  const change = { line: 1, text: "In Therapy 1, a light oak bench against its south wall, 2.4 m long (east-west), 0.4 m deep, 0.45 m high." };

  it('asks for "inside" when "in Therapy 1" was planned beside the room (that is outside it)', () => {
    const answer = JSON.stringify({ type: "steps", steps: [{ op: "build", id: "S1", name: "Bench", placement: { kind: "beside", anchor: "V2", side: "south", gap: 0.1, eastWest: 2.4, northSouth: 0.4 }, height: 0.45, tag: "T" }], reason: "" });
    expect(checkAnswer(answer, change, [], 1, t124(), OPTS).problems.join()).toMatch(/OUTSIDE that room; to put it in the room use \{"kind":"inside","anchor":"V2"/);
  });

  it("accepts the inside answer", () => {
    const answer = JSON.stringify({ type: "steps", steps: [{ op: "build", id: "S1", name: "Bench", placement: { kind: "inside", anchor: "V2", side: "south", gap: 0.1, eastWest: 2.4, northSouth: 0.4, shift: -2.485 }, height: 0.45, tag: "T" }], reason: "" });
    expect(checkAnswer(answer, change, [], 1, t124(), OPTS).problems).toEqual([]);
  });

  it("turns a room name into its V ref", () => {
    const notes: string[] = [];
    const out = namesToRefs({ steps: [{ op: "build", placement: { kind: "inside", anchor: "Therapy 1" } }] }, t124(), notes) as { steps: { placement: { anchor: string } }[] };
    expect(out.steps[0]!.placement.anchor).toBe("V2");
    expect(notes).toEqual([]);
  });
});

describe("collision lines", () => {
  it("joins collisions of one block with copies of one part (13 oak fins were 13 lines)", () => {
    const fin = { step: "S1", with: "oak fin 30x60 @180", path: ["T124", "Soft Air", "oak fin 30x60 @180"], overlap: [0.03, 0.03, 0.349] };
    const box = () => ({ min: [0, 0, 0] as [number, number, number], max: [1, 1, 1] as [number, number, number] });
    const out = sameCollisions([
      { ...fin, bounds: box(), overlap: [0.03, 0.03, 0.349] },
      { ...fin, bounds: box(), overlap: [0.03, 0.06, 0.349] },
      { ...fin, step: "S2", bounds: box(), overlap: [0.01, 0.03, 0.349] },
    ]);
    expect(out.map((o) => [o.c.step, o.n, o.c.overlap[1]])).toEqual([["S1", 2, 0.06], ["S2", 1, 0.03]]);
  });
});
